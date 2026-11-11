package org.llamenos.hotline.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.llamenos.protocol.CryptoLabels
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Serialized wake payload delivered inside an encrypted push envelope.
 *
 * Wake-tier payloads are decryptable without user PIN unlock because the
 * wake key is stored without user authentication requirements. They carry
 * only minimal metadata — enough to display "New call available" on the
 * lock screen without revealing caller identity.
 */
@Serializable
data class WakePayload(
    val type: String,
    val callId: String? = null,
    val shiftId: String? = null,
    val timestamp: Long = 0,
    val message: String? = null,
    val hubId: String? = null,
)

/**
 * Device-level wake key service for decrypting lock-screen push notifications.
 *
 * The wake keypair is generated once and stored in [KeystoreService] (backed by
 * Android Keystore / EncryptedSharedPreferences). Unlike the user's device keys,
 * the wake key does NOT require PIN/biometric to access — it must be available
 * when [PushService] receives a message while the device is locked.
 *
 * Flow:
 * 1. On first use, [getOrCreateWakePublicKey] generates an X25519 keypair and stores it
 * 2. The wake public key is registered with the server (POST /api/devices/register)
 * 3. Server encrypts push payloads with the device's wake public key via HPKE
 * 4. [PushService] calls [decryptWakePayload] to decrypt
 */
@Singleton
class WakeKeyService @Inject constructor(
    private val keystoreService: KeystoreService,
) {

    private val json = Json { ignoreUnknownKeys = true }

    private val nativeLibLoaded: Boolean get() = NativeCryptoLibrary.isLoaded

    /**
     * Get the wake public key, generating a new keypair if none exists.
     * This key is registered with the server for push notification encryption.
     *
     * The wake secret is generated and held in Rust state — it NEVER enters JVM memory
     * as raw bytes. For persistence, the secret is exported from Rust, encrypted under
     * a dedicated AndroidKeyStore AES-256-GCM key, and stored as Base64 ciphertext.
     * On subsequent app launches, the encrypted secret is loaded and sent back to Rust.
     */
    fun getOrCreateWakePublicKey(): String {
        val existing = keystoreService.retrieve(KEY_WAKE_PUBKEY)
        if (existing != null) {
            // Ensure the wake key is loaded into Rust state (may have been cleared)
            if (nativeLibLoaded && !org.llamenos.core.mobileHasWakeKey()) {
                loadWakeKeyIntoRust()
            }
            return existing
        }

        NativeCryptoLibrary.require()

        // Generate keypair entirely in Rust — secret never enters JVM
        val publicKeyHex = org.llamenos.core.mobileGenerateWakeKey()

        // Export secret from Rust for encrypted persistence only
        val secretHex = org.llamenos.core.mobileExportWakeKeyHex()
        val secretBytes = hexToBytes(secretHex)
        storeWakeSecret(secretBytes)
        // secretBytes zeroized inside storeWakeSecret

        keystoreService.store(KEY_WAKE_PUBKEY, publicKeyHex)
        return publicKeyHex
    }

    /**
     * Load the wake key secret from encrypted storage into Rust state.
     * Called on app startup when a wake key already exists in persistence.
     */
    internal fun loadWakeKeyIntoRust() {
        if (!nativeLibLoaded) return
        val secretBytes = loadWakeSecret() ?: return
        try {
            val secretHex = secretBytes.joinToString("") { "%02x".format(it) }
            org.llamenos.core.mobileLoadWakeKey(secretHex)
        } finally {
            secretBytes.fill(0)
        }
    }

    /** Exposed for testing only. */
    internal fun isNativeLoaded(): Boolean = nativeLibLoaded

    /**
     * Store the wake secret encrypted under a dedicated AndroidKeyStore AES-256-GCM key.
     * The input [secretBytes] is zeroized after encryption.
     */
    internal fun storeWakeSecret(secretBytes: ByteArray) {
        try {
            val keyStore = KeyStore.getInstance("AndroidKeyStore")
            keyStore.load(null)

            // Generate (or reuse) the hardware-backed AES key
            if (!keyStore.containsAlias(KeystoreService.WAKE_KEY_ALIAS)) {
                val spec = try {
                    // Request StrongBox hardware security module backing where available.
                    KeyGenParameterSpec.Builder(
                        KeystoreService.WAKE_KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .apply {
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                                setIsStrongBoxBacked(true)
                            }
                        }
                        .build()
                } catch (_: Exception) {
                    // StrongBox not available on this device — fall back to TEE-backed key.
                    KeyGenParameterSpec.Builder(
                        KeystoreService.WAKE_KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build()
                }
                val keyGen = KeyGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_AES,
                    "AndroidKeyStore",
                )
                keyGen.init(spec)
                keyGen.generateKey()
            }

            // Encrypt the secret
            val secretKey = (keyStore.getEntry(KeystoreService.WAKE_KEY_ALIAS, null)
                as KeyStore.SecretKeyEntry).secretKey
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(secretBytes)

            // Store IV + ciphertext as Base64
            val combined = iv + ciphertext
            keystoreService.store(KEY_WAKE_SECRET, Base64.encodeToString(combined, Base64.NO_WRAP))
        } finally {
            // Zeroize the input
            secretBytes.fill(0)
        }
    }

    /**
     * Load and decrypt the wake secret from EncryptedSharedPreferences,
     * using the dedicated AndroidKeyStore AES key.
     *
     * @return Decrypted wake secret as ByteArray, or null if not available.
     */
    internal fun loadWakeSecret(): ByteArray? {
        val stored = keystoreService.retrieve(KEY_WAKE_SECRET) ?: return null

        return try {
            val keyStore = KeyStore.getInstance("AndroidKeyStore")
            keyStore.load(null)

            if (!keyStore.containsAlias(KeystoreService.WAKE_KEY_ALIAS)) return null

            val combined = Base64.decode(stored, Base64.NO_WRAP)
            // AES-GCM IV is 12 bytes
            if (combined.size <= GCM_IV_LENGTH) return null

            val iv = combined.copyOfRange(0, GCM_IV_LENGTH)
            val ciphertext = combined.copyOfRange(GCM_IV_LENGTH, combined.size)

            val secretKey = (keyStore.getEntry(KeystoreService.WAKE_KEY_ALIAS, null)
                as KeyStore.SecretKeyEntry).secretKey
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH, iv))
            cipher.doFinal(ciphertext)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Clean up the wake key from Rust state, EncryptedSharedPreferences, and AndroidKeyStore.
     */
    fun cleanup() {
        // Clear from Rust state first
        if (nativeLibLoaded) {
            try { org.llamenos.core.mobileClearWakeKey() } catch (_: Exception) {}
        }
        keystoreService.delete(KEY_WAKE_SECRET)
        keystoreService.delete(KEY_WAKE_PUBKEY)
        try {
            val keyStore = KeyStore.getInstance("AndroidKeyStore")
            keyStore.load(null)
            keyStore.deleteEntry(KeystoreService.WAKE_KEY_ALIAS)
        } catch (_: Exception) {
            // KeyStore may not be available
        }
    }

    /**
     * Check whether a wake keypair has been generated.
     */
    fun hasWakeKey(): Boolean {
        return keystoreService.contains(KEY_WAKE_PUBKEY)
    }

    /**
     * Decrypt a wake-tier push notification payload using HPKE.
     * This is the v3 path — the server sends an HPKE envelope JSON.
     *
     * Decryption uses the wake key stored in Rust state. The secret never
     * enters JVM memory during the decryption path.
     */
    suspend fun decryptWakePayloadHpke(envelopeJson: String): WakePayload? =
        withContext(Dispatchers.Default) {
            if (!nativeLibLoaded) return@withContext null

            // Ensure wake key is loaded into Rust state
            if (!org.llamenos.core.mobileHasWakeKey()) {
                loadWakeKeyIntoRust()
                if (!org.llamenos.core.mobileHasWakeKey()) return@withContext null
            }

            try {
                val envelope = json.decodeFromString<HpkeEnvelopeJson>(envelopeJson)
                val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
                    v = envelope.v.toUByte(),
                    labelId = envelope.labelId.toUByte(),
                    enc = envelope.enc,
                    ct = envelope.ct,
                )
                val plaintextHex = org.llamenos.core.mobileHpkeOpenWithWakeKey(
                    envelope = ffiEnvelope,
                    expectedLabel = LABEL_PUSH_WAKE,
                    aadHex = "",
                )
                val bytes = hexToBytes(plaintextHex)
                val plaintext = String(bytes, Charsets.UTF_8)
                json.decodeFromString<WakePayload>(plaintext)
            } catch (_: Exception) {
                null
            }
        }

    /**
     * Decrypt a wake-tier push notification payload.
     *
     * Accepts an HPKE envelope JSON string. Delegates to [decryptWakePayloadHpke].
     */
    suspend fun decryptWakePayload(envelopeJson: String): WakePayload? =
        decryptWakePayloadHpke(envelopeJson)

    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "Hex string has odd length" }
        return ByteArray(hex.length / 2) { i ->
            hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    companion object {
        internal const val KEY_WAKE_SECRET = "wake-secret"
        internal const val KEY_WAKE_PUBKEY = "wake-pubkey"
        private val LABEL_PUSH_WAKE = CryptoLabels.LABEL_PUSH_WAKE

        /** AES-GCM IV length in bytes. */
        private const val GCM_IV_LENGTH = 12
        /** AES-GCM authentication tag length in bits. */
        private const val GCM_TAG_LENGTH = 128
    }
}

/**
 * HPKE envelope JSON structure for deserialization.
 */
@Serializable
private data class HpkeEnvelopeJson(
    val v: Int,
    val labelId: Int,
    val enc: String,
    val ct: String,
)
