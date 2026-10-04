package org.llamenos.hotline.crypto

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.llamenos.hotline.api.relay.RelayCrypto
import org.llamenos.hotline.model.NotePayload
import org.llamenos.protocol.CryptoLabels
import org.llamenos.protocol.HubKeyEnvelopeResponse
import org.llamenos.protocol.RecipientEnvelope
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * V3 device key model data classes.
 *
 * Device keys (Ed25519 signing + X25519 encryption) are generated once per device.
 * The PIN encrypts the device key blob. Secrets are held exclusively in Rust memory.
 */
data class DeviceKeyState(
    val deviceId: String,
    val signingPubkeyHex: String,
    val encryptionPubkeyHex: String,
)

data class EncryptedDeviceKeys(
    val kdfVersion: UByte,
    val salt: String,
    val argon2MCost: UInt,
    val argon2TCost: UInt,
    val argon2PCost: UInt,
    val nonce: String,
    val ciphertext: String,
    val state: DeviceKeyState,
)

data class AuthToken(
    val pubkey: String,
    val timestamp: Long,
    val token: String,
    val nonce: String? = null,
)

data class HpkeEnvelope(
    val v: Int,
    val labelId: Int,
    val enc: String,
    val ct: String,
) {
    companion object {
        /** HPKE envelope version — must match Rust ENVELOPE_VERSION */
        const val CURRENT_VERSION = 3

        // Label registry IDs — must match LABEL_REGISTRY indices in labels.rs.
        // These are the numeric wire-format IDs for each label.
        const val LABEL_ID_NOTE_KEY = 0
        const val LABEL_ID_FILE_KEY = 1
        const val LABEL_ID_FILE_METADATA = 2
        const val LABEL_ID_HUB_KEY_WRAP = 3
        const val LABEL_ID_MESSAGE = 5
        const val LABEL_ID_CALL_META = 6
    }
}

/** Data class for passing admin envelope data from API responses to crypto. */
data class AdminEnvelopeData(
    val pubkey: String,
    val enc: String,
    val ct: String,
)

/** Decrypted call metadata from E2EE envelope. */
@kotlinx.serialization.Serializable
data class CallMetadata(
    val callerNumber: String,
    val answeredBy: String? = null,
)

/** Result of encrypting a file with per-recipient HPKE envelopes. */
data class EncryptedFile(
    val encryptedContent: ByteArray,
    val keyEnvelopes: List<FileKeyEnvelope>,
    val metadataEnvelopes: List<EncryptedFileMetadataEnvelope>,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is EncryptedFile) return false
        return encryptedContent.contentEquals(other.encryptedContent) &&
            keyEnvelopes == other.keyEnvelopes &&
            metadataEnvelopes == other.metadataEnvelopes
    }

    override fun hashCode(): Int {
        var result = encryptedContent.contentHashCode()
        result = 31 * result + keyEnvelopes.hashCode()
        result = 31 * result + metadataEnvelopes.hashCode()
        return result
    }
}

data class FileKeyEnvelope(
    val pubkey: String,
    val enc: String,
    val ct: String,
)

data class EncryptedFileMetadataEnvelope(
    val pubkey: String,
    val encryptedContent: String,
    val enc: String,
    val ct: String,
)

@kotlinx.serialization.Serializable
data class FileMetadata(
    val originalName: String,
    val mimeType: String,
    val size: Long,
    val checksum: String,
)

/**
 * Result of encrypting a note/message.
 * [ciphertextHex] is AES-256-GCM encrypted content.
 * [envelopes] contain per-recipient HPKE-wrapped symmetric keys.
 */
data class EncryptedNote(
    val ciphertextHex: String,
    val envelopes: List<NoteEnvelope>,
)

data class NoteEnvelope(
    val recipientPubkey: String,
    val hpkeEnvelope: HpkeEnvelope,
)

data class EncryptedMessage(
    val ciphertextHex: String,
    val envelopes: List<RecipientEnvelope>,
)

@kotlinx.serialization.Serializable
data class ShamirShare(
    val x: Int,
    val y: String,
) {
    /** Convert to FFI ShamirShare type. */
    fun toFfi(): org.llamenos.core.ShamirShare =
        org.llamenos.core.ShamirShare(x = x.toUByte(), yHex = y)

    companion object {
        /** Convert from FFI ShamirShare type. */
        fun fromFfi(ffi: org.llamenos.core.ShamirShare): ShamirShare =
            ShamirShare(x = ffi.x.toInt(), y = ffi.yHex)
    }
}

data class RecoveryGroupKeypair(
    val publicKeyHex: String,
    val handle: ULong = 0u,
)

/**
 * Result of generating an ephemeral key for device linking.
 * The secret is held exclusively in Rust state — only the public key is available here.
 */
data class EphemeralKeyResult(
    val publicKeyHex: String,
)

class CryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * CryptoService wraps the llamenos-core native library via JNI/UniFFI.
 *
 * ## V3 Device Key Model
 * Device secrets (Ed25519 signing + X25519 encryption) are held exclusively in
 * Rust memory via the mobile FFI state. Kotlin only sees public keys and operation
 * results — secrets NEVER leave the Rust process.
 *
 * CRITICAL SECURITY INVARIANT: Device key material NEVER leaves this class or the
 * Rust FFI layer. All cryptographic operations that require private keys are performed
 * in Rust memory. External code only receives public keys and operation results.
 *
 * All CPU-intensive crypto operations run on [Dispatchers.Default] to avoid
 * blocking the main thread (Android ANR after 5s on main thread).
 */
@Singleton
class CryptoService @Inject constructor() : RelayCrypto {

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Dispatcher for CPU-intensive crypto operations.
     * Defaults to [Dispatchers.Default]; overridden in tests to use a test dispatcher.
     */
    internal var computeDispatcher: CoroutineDispatcher = Dispatchers.Default

    /** Ed25519 signing public key (hex). Used for identity. */
    var signingPubkeyHex: String? = null
        private set

    /** X25519 encryption public key (hex). Used for HPKE. */
    var encryptionPubkeyHex: String? = null
        private set

    /** Device identifier (UUID). */
    var deviceId: String? = null
        private set

    // Legacy alias for envelope matching — uses encryption pubkey for HPKE.
    val pubkey: String? get() = encryptionPubkeyHex

    val isUnlocked: Boolean
        get() = if (nativeLibLoaded) {
            try { org.llamenos.core.mobileIsUnlocked() } catch (_: Exception) { false }
        } else { false }

    /** Whether any device identity has been set (even if locked). */
    val hasIdentity: Boolean get() = signingPubkeyHex != null

    internal var nativeLibLoaded = false

    init {
        try {
            System.loadLibrary("llamenos_core")
            nativeLibLoaded = true
        } catch (_: UnsatisfiedLinkError) {
            nativeLibLoaded = false
        }
    }

    // ---- Device Key Generation ----

    /**
     * Generate new Ed25519 + X25519 device keys, encrypt with PIN, and load into Rust state.
     * Returns the encrypted key blob for persistent storage.
     * Device secrets stay in Rust memory — NEVER exposed to Kotlin.
     */
    suspend fun generateDeviceKeys(deviceId: String, pin: String): EncryptedDeviceKeys =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }

            try {
                val ffiResult = org.llamenos.core.mobileGenerateAndLoad(
                    deviceId = deviceId,
                    pin = pin,
                )
                val state = DeviceKeyState(
                    deviceId = ffiResult.state.deviceId,
                    signingPubkeyHex = ffiResult.state.signingPubkeyHex,
                    encryptionPubkeyHex = ffiResult.state.encryptionPubkeyHex,
                )
                this@CryptoService.signingPubkeyHex = state.signingPubkeyHex
                this@CryptoService.encryptionPubkeyHex = state.encryptionPubkeyHex
                this@CryptoService.deviceId = state.deviceId
                EncryptedDeviceKeys(
                    kdfVersion = ffiResult.kdfVersion,
                    salt = ffiResult.salt,
                    argon2MCost = ffiResult.argon2MCost,
                    argon2TCost = ffiResult.argon2TCost,
                    argon2PCost = ffiResult.argon2PCost,
                    nonce = ffiResult.nonce,
                    ciphertext = ffiResult.ciphertext,
                    state = state,
                )
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Device key generation failed: ${e.message}", e)
            }
        }

    // ---- Unlock / Lock ----

    /**
     * Decrypt device keys from PIN-encrypted storage and load into Rust state.
     */
    suspend fun unlockWithPin(data: EncryptedDeviceKeys, pin: String): DeviceKeyState =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }

            try {
                val ffiData = org.llamenos.core.EncryptedDeviceKeys(
                    kdfVersion = data.kdfVersion,
                    salt = data.salt,
                    argon2MCost = data.argon2MCost,
                    argon2TCost = data.argon2TCost,
                    argon2PCost = data.argon2PCost,
                    nonce = data.nonce,
                    ciphertext = data.ciphertext,
                    state = org.llamenos.core.DeviceKeyState(
                        deviceId = data.state.deviceId,
                        signingPubkeyHex = data.state.signingPubkeyHex,
                        encryptionPubkeyHex = data.state.encryptionPubkeyHex,
                    ),
                )
                val ffiState = org.llamenos.core.mobileUnlock(data = ffiData, pin = pin)
                val state = DeviceKeyState(
                    deviceId = ffiState.deviceId,
                    signingPubkeyHex = ffiState.signingPubkeyHex,
                    encryptionPubkeyHex = ffiState.encryptionPubkeyHex,
                )
                this@CryptoService.signingPubkeyHex = state.signingPubkeyHex
                this@CryptoService.encryptionPubkeyHex = state.encryptionPubkeyHex
                this@CryptoService.deviceId = state.deviceId
                state
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Decryption failed: incorrect PIN", e)
            }
        }

    /**
     * Lock by zeroizing device secrets in Rust memory.
     * Hub keys and server event keys are also zeroized in Rust.
     * Public keys are retained for locked-state display ("Locked as ...").
     */
    fun lock() {
        if (nativeLibLoaded) {
            try { org.llamenos.core.mobileLock() } catch (_: Exception) {}
        }
        testHubKeys.clear()
    }

    // ---- Auth Token (Ed25519) ----

    /**
     * Create an Ed25519-signed auth token for API requests.
     */
    suspend fun createAuthToken(method: String, path: String): AuthToken =
        withContext(computeDispatcher) {
            createAuthTokenInternal(method, path)
        }

    /**
     * Create an Ed25519 auth token synchronously.
     * Used by AuthInterceptor since OkHttp interceptors cannot use coroutines.
     */
    fun createAuthTokenSync(method: String, path: String): AuthToken {
        return createAuthTokenInternal(method, path)
    }

    private fun createAuthTokenInternal(method: String, path: String): AuthToken {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")

        val timestamp = System.currentTimeMillis()
        return try {
            val ffiToken = org.llamenos.core.mobileCreateAuthToken(
                timestamp = timestamp.toULong(),
                method = method,
                path = path,
            )
            // Use the nonce from the FFI token — the Rust layer generates a random
            // nonce and includes it in the signed message. Using a different nonce
            // here would cause signature verification to fail on the backend.
            AuthToken(
                pubkey = ffiToken.pubkey,
                timestamp = ffiToken.timestamp.toLong(),
                token = ffiToken.token,
                nonce = ffiToken.nonce,
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Auth token creation failed: ${e.message}", e)
        }
    }

    // ---- Note Encryption (HPKE) ----

    /**
     * Encrypt a note payload with per-note forward secrecy using HPKE key wrapping.
     *
     * 1. Generate random 32-byte symmetric key
     * 2. AES-256-GCM encrypt the payload with that key
     * 3. HPKE-seal the key to each recipient's X25519 pubkey
     */
    suspend fun encryptNote(
        payload: String,
        recipientPubkeys: List<String>,
    ): EncryptedNote = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")

        try {
            val plaintextHex = payload.toByteArray(Charsets.UTF_8)
                .joinToString("") { "%02x".format(it) }
            val result = org.llamenos.core.mobileSymmetricEncrypt(plaintextHex = plaintextHex)
            val ciphertextHex = result[0]
            val keyHex = result[1]

            val envelopes = recipientPubkeys.map { pubkey ->
                val hpkeEnv = org.llamenos.core.mobileHpkeSealKey(
                    keyHex = keyHex,
                    recipientPubkeyHex = pubkey,
                    label = CryptoLabels.LABEL_NOTE_KEY,
                    aadHex = "",
                )
                NoteEnvelope(
                    recipientPubkey = pubkey,
                    hpkeEnvelope = HpkeEnvelope(
                        v = hpkeEnv.v.toInt(),
                        labelId = hpkeEnv.labelId.toInt(),
                        enc = hpkeEnv.enc,
                        ct = hpkeEnv.ct,
                    ),
                )
            }

            EncryptedNote(ciphertextHex = ciphertextHex, envelopes = envelopes)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Note encryption failed: ${e.message}", e)
        }
    }

    // ---- Note Decryption (HPKE) ----

    /**
     * Decrypt a note using an HPKE envelope addressed to this device.
     */
    suspend fun decryptNote(
        ciphertextHex: String,
        envelope: HpkeEnvelope,
    ): NotePayload? = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) return@withContext null

        try {
            val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
                v = envelope.v.toUByte(),
                labelId = envelope.labelId.toUByte(),
                enc = envelope.enc,
                ct = envelope.ct,
            )
            val keyHex = org.llamenos.core.mobileHpkeOpenKey(
                envelope = ffiEnvelope,
                expectedLabel = CryptoLabels.LABEL_NOTE_KEY,
                aadHex = "",
            )
            val plaintextHex = org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = ciphertextHex,
                keyHex = keyHex,
            )
            val bytes = hexToBytes(plaintextHex)
            val plaintext = String(bytes, Charsets.UTF_8)
            json.decodeFromString<NotePayload>(plaintext)
        } catch (_: Exception) {
            null
        }
    }

    // ---- Message Encryption (HPKE) ----

    /**
     * Encrypt a message for multiple readers with per-message forward secrecy using HPKE.
     */
    suspend fun encryptMessage(
        plaintext: String,
        readerPubkeys: List<String>,
    ): EncryptedMessage = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        val encPubkey = encryptionPubkeyHex ?: throw CryptoException("No key loaded")

        try {
            val allReaders = (listOf(encPubkey) + readerPubkeys).distinct()
            val plaintextHex = plaintext.toByteArray(Charsets.UTF_8)
                .joinToString("") { "%02x".format(it) }
            val result = org.llamenos.core.mobileSymmetricEncrypt(plaintextHex = plaintextHex)
            val ciphertextHex = result[0]
            val keyHex = result[1]

            val envelopes = allReaders.map { pubkey ->
                val hpkeEnv = org.llamenos.core.mobileHpkeSealKey(
                    keyHex = keyHex,
                    recipientPubkeyHex = pubkey,
                    label = CryptoLabels.LABEL_MESSAGE,
                    aadHex = "",
                )
                RecipientEnvelope(
                    pubkey = pubkey,
                    enc = hpkeEnv.enc,
                    ct = hpkeEnv.ct,
                )
            }

            EncryptedMessage(ciphertextHex = ciphertextHex, envelopes = envelopes)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Message encryption failed: ${e.message}", e)
        }
    }

    // ---- Message Decryption (HPKE) ----

    /**
     * Decrypt a message using an HPKE envelope addressed to this device.
     */
    suspend fun decryptMessage(
        encryptedContent: String,
        envelope: HpkeEnvelope,
    ): String? = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) return@withContext null

        try {
            val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
                v = envelope.v.toUByte(),
                labelId = envelope.labelId.toUByte(),
                enc = envelope.enc,
                ct = envelope.ct,
            )
            val keyHex = org.llamenos.core.mobileHpkeOpenKey(
                envelope = ffiEnvelope,
                expectedLabel = CryptoLabels.LABEL_MESSAGE,
                aadHex = "",
            )
            val plaintextHex = org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = encryptedContent,
                keyHex = keyHex,
            )
            val bytes = hexToBytes(plaintextHex)
            String(bytes, Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    // ---- PUK Operations ----

    /** Create the initial Per-User Key (generation 1). */
    suspend fun createInitialPuk(): String = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            org.llamenos.core.mobilePukCreate()
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK creation failed: ${e.message}", e)
        }
    }

    /**
     * Rotate the Per-User Key to a new generation.
     *
     * @param oldSeedHex Hex-encoded seed of the current PUK generation
     * @param oldGen Current generation number
     * @param remainingDevicesJson JSON array of remaining authorized devices
     * @return New PUK state, HPKE envelopes for each device, and CLKR chain link
     */
    suspend fun rotatePuk(
        oldSeedHex: String,
        oldGen: UInt,
        remainingDevicesJson: String,
    ): org.llamenos.core.RotatePukResult = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            org.llamenos.core.mobilePukRotate(
                oldSeedHex = oldSeedHex,
                oldGen = oldGen,
                remainingDevicesJson = remainingDevicesJson,
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK rotation failed: ${e.message}", e)
        }
    }

    // ---- Sigchain Operations ----

    /** Create a new sigchain link signed by this device. */
    suspend fun createSigchainLink(
        id: String,
        seq: Long,
        prevHash: String?,
        timestamp: String,
        payloadJson: String,
    ): org.llamenos.core.SigchainLink = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            org.llamenos.core.mobileSigchainCreateLink(
                id = id,
                seq = seq.toULong(),
                prevHash = prevHash,
                timestamp = timestamp,
                payloadJson = payloadJson,
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Sigchain link creation failed: ${e.message}", e)
        }
    }

    /** Verify a single sigchain link against an expected signer pubkey. */
    suspend fun verifySigchainLink(
        linkJson: String,
        expectedSignerPubkey: String,
    ): Boolean = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        try {
            org.llamenos.core.mobileSigchainVerifyLink(linkJson, expectedSignerPubkey)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Sigchain link verification failed: ${e.message}", e)
        }
    }

    /** Verify a complete sigchain (all links). */
    suspend fun verifySigchain(
        linksJson: String,
    ): org.llamenos.core.SigchainVerifiedState = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        try {
            org.llamenos.core.mobileSigchainVerify(linksJson)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Sigchain verification failed: ${e.message}", e)
        }
    }

    // ---- PUK Rotation (CLKR) ----

    /**
     * Rotate the PUK to a new generation (Cascading Lazy Key Rotation).
     * Called when membership or role changes require key rotation to exclude departed members.
     *
     * @param oldSeedHex Current PUK seed (hex)
     * @param oldGen Current generation number
     * @param remainingDevicesJson JSON array of [deviceId, encryptionPubkeyHex] tuples for remaining members
     */
    suspend fun rotatePuk(
        oldSeedHex: String,
        oldGen: Int,
        remainingDevicesJson: String,
    ): org.llamenos.core.RotatePukResult = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            org.llamenos.core.mobilePukRotate(
                oldSeedHex = oldSeedHex,
                oldGen = oldGen.toUInt(),
                remainingDevicesJson = remainingDevicesJson,
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK rotation failed: ${e.message}", e)
        }
    }

    /** Unwrap a PUK seed from an HPKE envelope using the device's X25519 key. */
    suspend fun unwrapPukSeed(
        envelope: HpkeEnvelope,
        expectedLabel: String,
    ): String = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
                v = envelope.v.toUByte(),
                labelId = envelope.labelId.toUByte(),
                enc = envelope.enc,
                ct = envelope.ct,
            )
            org.llamenos.core.mobilePukUnwrapSeed(
                envelope = ffiEnvelope,
                expectedLabel = expectedLabel,
                aadHex = "",
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK seed unwrap failed: ${e.message}", e)
        }
    }

    /** Derive PUK subkeys for a given seed + generation (stateless). */
    suspend fun derivePukState(
        seedHex: String,
        generation: Int,
    ): org.llamenos.core.PukState = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        try {
            org.llamenos.core.mobilePukDeriveState(
                seedHex = seedHex,
                generation = generation.toUInt(),
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK state derivation failed: ${e.message}", e)
        }
    }

    // ---- Server Event Decryption ----

    /**
     * Decrypt a server-encrypted event payload (XChaCha20-Poly1305) with an explicit key.
     */
    fun decryptServerEvent(encryptedHex: String, keyHex: String): String? {
        if (!nativeLibLoaded) return null
        return try {
            org.llamenos.core.decryptServerEventHex(encryptedHex, keyHex)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Decrypt a relay event payload the server encrypted for [epoch], using the Rust-stored
     * server event keys (current + previous epoch). Matches the server's format: AAD
     * `LABEL_HUB_EVENT_EPOCH:{epoch}` and power-of-two padding (`apps/worker/lib/ws-events.ts`).
     * Returns null if no keys are set or decryption fails with both keys.
     */
    override fun decryptServerEventForEpoch(payloadHex: String, epoch: Long): String? {
        if (!nativeLibLoaded || epoch < 0) return null
        return try {
            org.llamenos.core.mobileDecryptServerEventWithEpoch(payloadHex, epoch.toULong())
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Store server event keys in Rust memory for epoch-based rotation.
     * Keys are held exclusively in Rust — never in JVM memory.
     *
     * @param currentHex Current epoch key (32 bytes, hex-encoded)
     * @param previousHex Previous epoch key, or null if none. Rust rejects anything that
     *   is not exactly 32 bytes, so "no previous key" must be null, never an empty string.
     */
    fun setServerEventKeys(currentHex: String, previousHex: String? = null) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        try {
            org.llamenos.core.mobileSetServerEventKeys(currentHex, previousHex?.takeIf { it.isNotEmpty() })
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Failed to set server event keys: ${e.message}", e)
        }
    }

    // ---- WebSocket relay (RelayCrypto) ----

    override val relayDevicePubkeyHex: String?
        get() = signingPubkeyHex

    /**
     * Sign a relay auth challenge with the device Ed25519 key held in Rust.
     * @throws IllegalStateException if the native library is missing or the key store is locked
     */
    override fun signRelayChallenge(messageHex: String): String {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        check(isUnlocked) { "Key store is locked." }
        return try {
            org.llamenos.core.mobileSign(messageHex)
        } catch (e: org.llamenos.core.CryptoException) {
            throw IllegalStateException("Failed to sign relay challenge: ${e.message}", e)
        }
    }

    /** Verify a server Ed25519 signature (stateless). Returns false on any failure. */
    override fun verifyServerEventSignature(
        messageHex: String,
        signatureHex: String,
        serverPubkeyHex: String,
    ): Boolean {
        if (!nativeLibLoaded) return false
        return try {
            org.llamenos.core.mobileEd25519Verify(messageHex, signatureHex, serverPubkeyHex)
        } catch (_: Exception) {
            false
        }
    }

    // ---- Device Linking (ECDH provisioning) ----

    /**
     * Generate an ephemeral X25519 keypair for device linking ECDH.
     *
     * The secret key is held exclusively in Rust state — it NEVER crosses JNI.
     * Returns only the public key. Use [ecdhComplete] to derive the shared secret.
     */
    fun generateEphemeralKey(): EphemeralKeyResult {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        return try {
            val publicKeyHex = org.llamenos.core.mobileGenerateEphemeralKey()
            EphemeralKeyResult(publicKeyHex)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Ephemeral key generation failed: ${e.message}", e)
        }
    }

    /**
     * Perform ECDH using the stored ephemeral secret and the peer's public key.
     *
     * The ephemeral secret is zeroized and removed from Rust state after this call.
     * Returns the shared secret hex for SAS derivation and provisioning decryption.
     */
    fun ecdhComplete(theirPublicKeyHex: String): String {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        return try {
            org.llamenos.core.mobileEcdhComplete(theirPublicKeyHex)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("ECDH derivation failed: ${e.message}", e)
        }
    }

    /**
     * Clear the ephemeral key from Rust state without performing ECDH.
     * Called when the device linking flow is cancelled.
     */
    fun clearEphemeralKey() {
        if (nativeLibLoaded) {
            org.llamenos.core.mobileClearEphemeralKey()
        }
    }

    /**
     * Decrypt data encrypted with a shared secret (XChaCha20-Poly1305).
     * Used during device linking.
     */
    suspend fun decryptWithSharedSecret(
        ciphertextHex: String,
        sharedSecretHex: String,
    ): String = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        try {
            org.llamenos.core.decryptWithSharedKeyHex(ciphertextHex, sharedSecretHex)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Shared secret decryption failed: ${e.message}", e)
        }
    }

    /**
     * Derive a 6-digit SAS verification code from a shared secret.
     */
    fun deriveSASCode(sharedSecret: String): String {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        return try {
            org.llamenos.core.computeSasCode(sharedSecret)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("SAS code derivation failed: ${e.message}", e)
        }
    }

    // ---- Hub Key Management ----
    // Hub keys are stored exclusively in Rust memory — NEVER in JVM/Kotlin memory.
    // The Kotlin-side ConcurrentHashMap is only used as a fallback for JVM tests
    // where the native library is unavailable.

    private val testHubKeys: MutableMap<String, String> = ConcurrentHashMap()

    fun hasHubKey(hubId: String): Boolean =
        if (nativeLibLoaded) org.llamenos.core.mobileHasHubKey(hubId)
        else testHubKeys.containsKey(hubId)

    fun clearHubKeys() {
        if (nativeLibLoaded) {
            org.llamenos.core.mobileClearHubKeys()
            org.llamenos.core.mobileClearServerEventKeys()
        }
        testHubKeys.clear()
    }

    /**
     * Unwrap and cache the hub key using HPKE from a server-provided envelope.
     *
     * The unwrapped key is stored in Rust memory — it never enters JVM memory.
     * Envelope version and label ID are constructed by Rust from the label registry,
     * so Kotlin never hardcodes protocol constants.
     */
    suspend fun loadHubKey(hubId: String, envelope: HubKeyEnvelopeResponse): Unit =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            if (!isUnlocked) throw CryptoException("No key loaded")

            try {
                org.llamenos.core.mobileLoadHubKey(
                    hubId = hubId,
                    enc = envelope.envelope.enc,
                    ct = envelope.envelope.ct,
                )
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Hub key decryption failed for hub $hubId: ${e.message}", e)
            }
        }

    /**
     * Decrypt a hub event using the Rust-stored hub key.
     * Returns decrypted JSON string or null if decryption fails.
     */
    fun decryptHubEvent(encryptedHex: String, hubId: String): String? {
        if (!nativeLibLoaded) return null
        return try {
            org.llamenos.core.mobileDecryptHubEvent(encryptedHex, hubId)
        } catch (_: Exception) {
            null
        }
    }

    // ---- Shamir Secret Sharing ----

    suspend fun shamirSplit(secretHex: String, total: Int, threshold: Int): List<ShamirShare> =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            try {
                val ffiShares = org.llamenos.core.mobileShamirSplit(
                    secretHex = secretHex,
                    total = total.toUByte(),
                    threshold = threshold.toUByte(),
                )
                ffiShares.map { ShamirShare.fromFfi(it) }
            } catch (e: Exception) {
                throw CryptoException("Shamir split failed: ${e.message}", e)
            }
        }

    suspend fun shamirCombine(shares: List<ShamirShare>, threshold: Int = shares.size): String =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            try {
                org.llamenos.core.mobileShamirCombine(
                    shares = shares.map { it.toFfi() },
                    threshold = threshold.toUByte(),
                )
            } catch (e: Exception) {
                throw CryptoException("Shamir combine failed: ${e.message}", e)
            }
        }

    suspend fun shamirCommit(share: ShamirShare): String =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            try {
                org.llamenos.core.mobileShamirCommit(share = share.toFfi())
            } catch (e: Exception) {
                throw CryptoException("Shamir commit failed: ${e.message}", e)
            }
        }

    suspend fun shamirVerify(share: ShamirShare, commitment: String): Boolean =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            try {
                org.llamenos.core.mobileShamirVerify(share = share.toFfi(), commitmentHex = commitment)
            } catch (e: Exception) {
                throw CryptoException("Shamir verify failed: ${e.message}", e)
            }
        }

    // ---- Recovery Group ----

    suspend fun recoveryGroupGenerateKeypair(): RecoveryGroupKeypair =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            try {
                val ffiKeypair = org.llamenos.core.mobileRecoveryGroupGenerateKeypair()
                RecoveryGroupKeypair(
                    publicKeyHex = ffiKeypair.publicKeyHex,
                    handle = ffiKeypair.handle,
                )
            } catch (e: Exception) {
                throw CryptoException("Recovery group keypair generation failed: ${e.message}", e)
            }
        }

    // ---- Call Metadata Decryption (HPKE) ----

    /**
     * Decrypt call metadata (callerNumber, answeredBy) from an E2EE admin envelope.
     * Finds the envelope addressed to this device, HPKE-opens the symmetric key,
     * then AES-GCM decrypts the call content.
     * Returns null if no matching envelope is found or decryption fails.
     */
    suspend fun decryptCallMetadata(
        encryptedContent: String,
        adminEnvelopes: List<AdminEnvelopeData>,
    ): CallMetadata? = withContext(computeDispatcher) {
        if (!nativeLibLoaded || !isUnlocked) return@withContext null
        val ourPubkey = encryptionPubkeyHex ?: return@withContext null

        val myEnvelope = adminEnvelopes.find { it.pubkey == ourPubkey }
            ?: return@withContext null

        try {
            val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
                v = HpkeEnvelope.CURRENT_VERSION.toUByte(),
                labelId = HpkeEnvelope.LABEL_ID_CALL_META.toUByte(),
                enc = myEnvelope.enc,
                ct = myEnvelope.ct,
            )
            val keyHex = org.llamenos.core.mobileHpkeOpenKey(
                envelope = ffiEnvelope,
                expectedLabel = CryptoLabels.LABEL_CALL_META,
                aadHex = "",
            )
            val plaintextHex = org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = encryptedContent,
                keyHex = keyHex,
            )
            val bytes = hexToBytes(plaintextHex)
            val plaintext = String(bytes, Charsets.UTF_8)
            json.decodeFromString<CallMetadata>(plaintext)
        } catch (_: Exception) {
            null
        }
    }

    // ---- File Encryption (HPKE) ----

    /**
     * Encrypt file data with per-recipient HPKE key wrapping.
     *
     * 1. Generate random symmetric key via mobileSymmetricEncrypt
     * 2. AES-GCM encrypt file content
     * 3. HPKE-seal the file key per recipient with LABEL_FILE_KEY
     * 4. Encrypt metadata JSON per recipient with LABEL_FILE_METADATA
     */
    suspend fun encryptFile(
        data: ByteArray,
        fileName: String,
        mimeType: String,
        recipientPubkeys: List<String>,
    ): EncryptedFile = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")

        try {
            // SHA-256 checksum of plaintext
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            val checksumBytes = digest.digest(data)
            val checksum = checksumBytes.joinToString("") { "%02x".format(it) }

            // Encrypt file content — mobileSymmetricEncrypt returns [ciphertextHex, keyHex]
            val dataHex = data.joinToString("") { "%02x".format(it) }
            val encResult = org.llamenos.core.mobileSymmetricEncrypt(plaintextHex = dataHex)
            val encryptedContentHex = encResult[0]
            val fileKeyHex = encResult[1]
            val encryptedContent = hexToBytes(encryptedContentHex)

            // HPKE-wrap file key for each recipient
            val keyEnvelopes = recipientPubkeys.map { pubkey ->
                val env = org.llamenos.core.mobileHpkeSealKey(
                    keyHex = fileKeyHex,
                    recipientPubkeyHex = pubkey,
                    label = CryptoLabels.LABEL_FILE_KEY,
                    aadHex = "",
                )
                FileKeyEnvelope(pubkey = pubkey, enc = env.enc, ct = env.ct)
            }

            // Build and encrypt metadata per recipient
            val metadata = json.encodeToString(
                kotlinx.serialization.serializer<FileMetadata>(),
                FileMetadata(
                    originalName = fileName,
                    mimeType = mimeType,
                    size = data.size.toLong(),
                    checksum = checksum,
                ),
            )
            val metaHex = metadata.toByteArray(Charsets.UTF_8)
                .joinToString("") { "%02x".format(it) }

            val metaEnvelopes = recipientPubkeys.map { pubkey ->
                val metaResult = org.llamenos.core.mobileSymmetricEncrypt(plaintextHex = metaHex)
                val encMetaHex = metaResult[0]
                val metaKeyHex = metaResult[1]
                val env = org.llamenos.core.mobileHpkeSealKey(
                    keyHex = metaKeyHex,
                    recipientPubkeyHex = pubkey,
                    label = CryptoLabels.LABEL_FILE_METADATA,
                    aadHex = "",
                )
                EncryptedFileMetadataEnvelope(
                    pubkey = pubkey,
                    encryptedContent = encMetaHex,
                    enc = env.enc,
                    ct = env.ct,
                )
            }

            EncryptedFile(encryptedContent, keyEnvelopes, metaEnvelopes)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("File encryption failed: ${e.message}", e)
        }
    }

    /**
     * Decrypt a file key from an HPKE envelope with LABEL_FILE_KEY.
     */
    suspend fun decryptFileKey(envelope: HpkeEnvelope): String = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")

        val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
            v = envelope.v.toUByte(),
            labelId = envelope.labelId.toUByte(),
            enc = envelope.enc,
            ct = envelope.ct,
        )
        try {
            org.llamenos.core.mobileHpkeOpenKey(
                envelope = ffiEnvelope,
                expectedLabel = CryptoLabels.LABEL_FILE_KEY,
                aadHex = "",
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("File key decryption failed: ${e.message}", e)
        }
    }

    /**
     * Decrypt file metadata from an HPKE envelope with LABEL_FILE_METADATA.
     */
    suspend fun decryptFileMetadata(
        encryptedContentHex: String,
        envelope: HpkeEnvelope,
    ): FileMetadata? = withContext(computeDispatcher) {
        if (!nativeLibLoaded || !isUnlocked) return@withContext null

        try {
            val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
                v = envelope.v.toUByte(),
                labelId = envelope.labelId.toUByte(),
                enc = envelope.enc,
                ct = envelope.ct,
            )
            val keyHex = org.llamenos.core.mobileHpkeOpenKey(
                envelope = ffiEnvelope,
                expectedLabel = CryptoLabels.LABEL_FILE_METADATA,
                aadHex = "",
            )
            val plaintextHex = org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = encryptedContentHex,
                keyHex = keyHex,
            )
            val bytes = hexToBytes(plaintextHex)
            json.decodeFromString<FileMetadata>(String(bytes, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Decrypt file content using a previously-unwrapped file key.
     */
    suspend fun decryptFileContent(
        encryptedContentHex: String,
        fileKeyHex: String,
    ): ByteArray = withContext(computeDispatcher) {
        check(nativeLibLoaded) { "Native crypto library not loaded." }
        if (!isUnlocked) throw CryptoException("No key loaded")

        try {
            val plaintextHex = org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = encryptedContentHex,
                keyHex = fileKeyHex,
            )
            hexToBytes(plaintextHex)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("File content decryption failed: ${e.message}", e)
        }
    }

    // ---- Draft Encryption ----

    /**
     * Encrypt a draft using the hub key for the given hub.
     * Uses HKDF with HKDF_CONTEXT_DRAFTS to derive a draft-specific key from the hub key.
     * Returns hex-encoded encrypted draft.
     */
    suspend fun encryptDraft(plaintext: String, hubId: String): String =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            if (!isUnlocked) throw CryptoException("No key loaded")
            try {
                org.llamenos.core.mobileEncryptDraft(plaintext = plaintext, hubId = hubId)
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Draft encryption failed: ${e.message}", e)
            }
        }

    /**
     * Decrypt a draft using the hub key for the given hub.
     * Returns the plaintext string.
     */
    suspend fun decryptDraft(packedHex: String, hubId: String): String =
        withContext(computeDispatcher) {
            check(nativeLibLoaded) { "Native crypto library not loaded." }
            if (!isUnlocked) throw CryptoException("No key loaded")
            try {
                org.llamenos.core.mobileDecryptDraft(packedHex = packedHex, hubId = hubId)
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Draft decryption failed: ${e.message}", e)
            }
        }

    // ---- Hex Utility ----

    private fun randomNonce(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "Hex string has odd length" }
        return ByteArray(hex.length / 2) { i ->
            hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    // ---- Test Support ----

    internal fun injectHubKeyForTest(hubId: String, keyHex: String) {
        if (nativeLibLoaded) {
            org.llamenos.core.mobileSetHubKey(hubId, keyHex)
        } else {
            testHubKeys[hubId] = keyHex
        }
    }

    /**
     * Set up test key state without native library calls.
     */
    internal fun setTestKeyState(
        signing: String,
        encryption: String,
        device: String,
    ) {
        signingPubkeyHex = signing
        encryptionPubkeyHex = encryption
        deviceId = device
    }
}
