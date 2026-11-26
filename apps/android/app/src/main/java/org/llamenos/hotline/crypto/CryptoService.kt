package org.llamenos.hotline.crypto

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
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
    /**
     * X-Wing (ML-KEM-768 + X25519) public key, 2432 hex chars — the device's
     * crypto_format 2 key (wire spec D16), published by a `device_kem` link.
     * Null only for a pilot blob not yet unlocked since K-A (#2496); unlocking
     * gives it one ([CryptoService.unlockWithPin]).
     */
    val kemPubkeyHex: String? = null,
) {
    internal fun toFfi() = org.llamenos.core.DeviceKeyState(
        deviceId = deviceId,
        signingPubkeyHex = signingPubkeyHex,
        encryptionPubkeyHex = encryptionPubkeyHex,
        kemPubkeyHex = kemPubkeyHex,
    )

    internal companion object {
        fun fromFfi(s: org.llamenos.core.DeviceKeyState) = DeviceKeyState(
            deviceId = s.deviceId,
            signingPubkeyHex = s.signingPubkeyHex,
            encryptionPubkeyHex = s.encryptionPubkeyHex,
            kemPubkeyHex = s.kemPubkeyHex,
        )
    }
}

data class EncryptedDeviceKeys(
    val kdfVersion: UByte,
    val salt: String,
    val argon2MCost: UInt,
    val argon2TCost: UInt,
    val argon2PCost: UInt,
    val nonce: String,
    val ciphertext: String,
    val state: DeviceKeyState,
) {
    internal fun toFfi() = org.llamenos.core.EncryptedDeviceKeys(
        kdfVersion = kdfVersion,
        salt = salt,
        argon2MCost = argon2MCost,
        argon2TCost = argon2TCost,
        argon2PCost = argon2PCost,
        nonce = nonce,
        ciphertext = ciphertext,
        state = state.toFfi(),
    )

    internal companion object {
        fun fromFfi(e: org.llamenos.core.EncryptedDeviceKeys) = EncryptedDeviceKeys(
            kdfVersion = e.kdfVersion,
            salt = e.salt,
            argon2MCost = e.argon2MCost,
            argon2TCost = e.argon2TCost,
            argon2PCost = e.argon2PCost,
            nonce = e.nonce,
            ciphertext = e.ciphertext,
            state = DeviceKeyState.fromFfi(e.state),
        )
    }
}

/**
 * The result of a PIN unlock: the device state, and — for a pilot device whose
 * blob had no X-Wing key — the re-encrypted blob that now holds one. The caller
 * MUST store [upgradedKeys] in place of the old blob when it is not null
 * (spec 2026-11-25-v2-device-linking-and-recovery §5).
 */
data class UnlockResult(
    val state: DeviceKeyState,
    val upgradedKeys: EncryptedDeviceKeys? = null,
)

data class AuthToken(
    val pubkey: String,
    val timestamp: Long,
    val token: String,
    val nonce: String? = null,
)

/**
 * The one HPKE envelope on the wire (spec D1, D2): `{enc, ct}`, lowercase hex.
 * There is no version and no `labelId`: the label is the SHAPE's
 * ([org.llamenos.core.Shape]), and the crate supplies it, and the AAD, from the
 * shape alone.
 */
data class HpkeEnvelope(
    val enc: String,
    val ct: String,
) {
    /** The UniFFI record — the same two fields. */
    fun toFfi(): org.llamenos.core.HpkeEnvelope = org.llamenos.core.HpkeEnvelope(enc = enc, ct = ct)
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

/**
 * A sealed case ciphertext — a record's summary or fields, or a case comment —
 * in wire form: [ciphertextHex] is the API's `encrypted*` field and [envelopes]
 * its `*Envelopes` list, unchanged.
 */
data class EncryptedCase(
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
class CryptoService @Inject constructor() {

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

    /** This device's X-Wing public key, once unlocked (see [DeviceKeyState.kemPubkeyHex]). */
    var kemPubkeyHex: String? = null
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

    private val _unlockedState = MutableStateFlow(false)

    /**
     * Whether device keys are loaded, as a stream: `true` after [generateDeviceKeys] or
     * [unlockWithPin], `false` after [lock]. Every caller of [lock] (the Lock buttons, the
     * background auto-lock, logout) is followed by the UI through this, so a locked app
     * never keeps showing unlocked screens.
     */
    val unlockedState: StateFlow<Boolean> = _unlockedState.asStateFlow()

    /** Whether any device identity has been set (even if locked). */
    val hasIdentity: Boolean get() = signingPubkeyHex != null

    internal val nativeLibLoaded: Boolean get() = NativeCryptoLibrary.isLoaded

    init {
        if (nativeLibLoaded) {
            // Arm UniFFI's binding/library integrity check: contract version plus a
            // per-function checksum. Nothing else ever references the generated
            // `IntegrityCheckingUniffiLib`, so without this call the check never runs —
            // the checked-in binding drifted from the crate (three checksums) and
            // nothing noticed. A mismatch throws here, at construction, rather than
            // surfacing as undefined behaviour at some later JNA call.
            org.llamenos.core.uniffiEnsureInitialized()
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
            NativeCryptoLibrary.require()

            try {
                val ffiResult = org.llamenos.core.mobileGenerateAndLoad(
                    deviceId = deviceId,
                    pin = pin,
                )
                val encrypted = EncryptedDeviceKeys.fromFfi(ffiResult)
                adopt(encrypted.state)
                encrypted
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Device key generation failed: ${e.message}", e)
            }
        }

    // ---- Unlock / Lock ----

    /**
     * Decrypt device keys from PIN-encrypted storage and load into Rust state.
     */
    suspend fun unlockWithPin(data: EncryptedDeviceKeys, pin: String): UnlockResult =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()

            try {
                val result = if (data.state.kemPubkeyHex == null) {
                    // A pilot blob: unlock and gain an X-Wing key in one step (spec §5).
                    val upgraded = EncryptedDeviceKeys.fromFfi(
                        org.llamenos.core.mobileAddDeviceKemKeyAndLoad(data = data.toFfi(), pin = pin),
                    )
                    UnlockResult(upgraded.state, upgraded)
                } else {
                    UnlockResult(DeviceKeyState.fromFfi(org.llamenos.core.mobileUnlock(data = data.toFfi(), pin = pin)))
                }
                adopt(result.state)
                result
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Decryption failed: incorrect PIN", e)
            }
        }

    private fun adopt(state: DeviceKeyState) {
        signingPubkeyHex = state.signingPubkeyHex
        encryptionPubkeyHex = state.encryptionPubkeyHex
        kemPubkeyHex = state.kemPubkeyHex
        deviceId = state.deviceId
        _unlockedState.value = true
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
        _unlockedState.value = false
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

    /**
     * Create an Ed25519 auth token signed WITHOUT a nonce.
     *
     * Only for routes whose wire schema has no `nonce` field — today that is
     * `POST /api/invites/redeem` alone. The message is signed under
     * `LABEL_DEVICE_AUTH_NO_NONCE`, a domain the server accepts only on routes
     * that opt in, so this token is useless anywhere else. Every other call
     * site must use [createAuthToken].
     */
    suspend fun createAuthTokenWithoutNonce(method: String, path: String): AuthToken =
        withContext(computeDispatcher) {
            createAuthTokenWithoutNonceInternal(method, path)
        }

    private fun createAuthTokenWithoutNonceInternal(method: String, path: String): AuthToken {
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")

        val timestamp = System.currentTimeMillis()
        return try {
            val ffiToken = org.llamenos.core.mobileCreateAuthTokenWithoutNonce(
                timestamp = timestamp.toULong(),
                method = method,
                path = path,
            )
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

    private fun createAuthTokenInternal(method: String, path: String): AuthToken {
        NativeCryptoLibrary.require()
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

    /**
     * Proof of key ownership for invite redemption (`POST [path]`).
     *
     * The redeem body carries `{pubkey, timestamp, token}` and has no nonce field
     * (protocol `RedeemInviteBody`), so the server verifies the signature over the
     * nonce-less device-auth message. [createAuthToken] always signs a fresh nonce into
     * the message, which that body cannot carry.
     */
    suspend fun createInviteRedemptionToken(path: String): AuthToken =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
            if (!isUnlocked) throw CryptoException("No key loaded")
            val pubkey = signingPubkeyHex ?: throw CryptoException("No device identity")
            val timestamp = System.currentTimeMillis()
            try {
                // The canonical nonce-less builder (#1509) — never hand-assemble the
                // signed string.
                val message = org.llamenos.core.mobileBuildAuthMessage(
                    pubkeyHex = pubkey,
                    timestamp = timestamp.toULong(),
                    method = "POST",
                    path = path,
                    nonce = null,
                )
                val signature = org.llamenos.core.mobileSign(
                    messageHex = message.joinToString("") { "%02x".format(it) },
                )
                AuthToken(pubkey = pubkey, timestamp = timestamp, token = signature)
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Invite redemption signature failed: ${e.message}", e)
            }
        }

    /**
     * Sign an arbitrary message with the device's Ed25519 signing key.
     *
     * Used for the WebSocket relay challenge-response handshake, where the
     * signed message is `LABEL_WS_CHALLENGE:{pubkey}:{nonce}:{ts}`.
     * Returns null when the native library is unavailable or the device is locked.
     */
    fun ed25519Sign(messageHex: String): String? {
        if (!nativeLibLoaded || !isUnlocked) return null
        return try {
            org.llamenos.core.mobileSign(messageHex)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Verify an Ed25519 signature over [messageHex] against [pubkeyHex].
     *
     * Stateless — needs no device secrets, so it works while locked. Returns false
     * for a bad signature, malformed hex, or when the native library is unavailable:
     * a caller gating a destructive action on this must treat "cannot verify" as
     * "not verified".
     */
    fun ed25519Verify(messageHex: String, signatureHex: String, pubkeyHex: String): Boolean {
        if (!nativeLibLoaded) return false
        return try {
            org.llamenos.core.mobileEd25519Verify(messageHex, signatureHex, pubkeyHex)
        } catch (_: org.llamenos.core.CryptoException) {
            false
        }
    }

    // ---- Note Encryption (HPKE, by shape) ----
    //
    // Every envelope below names a shape (org.llamenos.core.Shape); the crate maps
    // it to the label and the AAD. Nothing in this file spells either (spec D1).

    private fun utf8Hex(text: String): String =
        text.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }

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
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")

        try {
            val result = org.llamenos.core.mobileContentSeal(
                shape = org.llamenos.core.Shape.NOTE_KEY,
                plaintextHex = utf8Hex(payload),
            )
            val ciphertextHex = result[0]
            val keyHex = result[1]

            val envelopes = recipientPubkeys.map { pubkey ->
                val env = org.llamenos.core.mobileShapeSeal(
                    shape = org.llamenos.core.Shape.NOTE_KEY,
                    recipientPubkeyHex = pubkey,
                    aadFields = emptyList(),
                    plaintextHex = keyHex,
                )
                NoteEnvelope(
                    recipientPubkey = pubkey,
                    hpkeEnvelope = HpkeEnvelope(enc = env.enc, ct = env.ct),
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
        NativeCryptoLibrary.require()
        if (!isUnlocked) return@withContext null

        try {
            // The content key never leaves Rust: one call unwraps and opens.
            val plaintextHex = org.llamenos.core.mobileOpenSealedContent(
                shape = org.llamenos.core.Shape.NOTE_KEY,
                ciphertextHex = ciphertextHex,
                envelope = envelope.toFfi(),
            )
            val bytes = hexToBytes(plaintextHex)
            val plaintext = String(bytes, Charsets.UTF_8)
            json.decodeFromString<NotePayload>(plaintext)
        } catch (_: Exception) {
            null
        }
    }

    // ---- Message Encryption (stored-record format) ----

    /**
     * Seal a conversation message (`LABEL_MESSAGE`) for this device and [readerPubkeys].
     *
     * The format is the stored record of `PROTOCOL.md` §2.4 — empty AAD on both the
     * content layer and the key wrap, label bound as HPKE `info` only — and Rust
     * chooses it ([org.llamenos.core.mobileEncryptMessage]), not this function. This
     * used to assemble the record from a raw symmetric seal + raw HPKE key wrap
     * under the canonical notes AAD, which no server or desktop reader supplies, so
     * every message an Android device wrote was unreadable by everyone else (#1927).
     */
    suspend fun encryptMessage(
        plaintext: String,
        readerPubkeys: List<String>,
    ): EncryptedMessage = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        val encPubkey = encryptionPubkeyHex ?: throw CryptoException("No key loaded")

        try {
            val sealed = org.llamenos.core.mobileEncryptMessage(
                plaintext = plaintext,
                readerPubkeys = (listOf(encPubkey) + readerPubkeys).distinct(),
            )
            EncryptedMessage(
                ciphertextHex = sealed.encryptedContent,
                envelopes = sealed.readerEnvelopes.map {
                    RecipientEnvelope(pubkey = it.pubkey, enc = it.enc, ct = it.ct)
                },
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Message encryption failed: ${e.message}", e)
        }
    }

    // ---- Message Decryption (stored-record format) ----

    /**
     * Open a `LABEL_MESSAGE` stored record as this device, whoever sealed it — the
     * server on webhook receipt, the desktop, or another phone.
     *
     * [envelopes] are the record's reader envelopes exactly as they arrive on the wire
     * (hex `enc`/`ct`); Rust finds the one addressed to this device and binds the AAD
     * ([org.llamenos.core.mobileDecryptMessage]). Returns null when no envelope is ours
     * or the record does not open.
     */
    suspend fun decryptMessage(
        encryptedContent: String,
        envelopes: List<RecipientEnvelope>,
    ): String? = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        if (!isUnlocked) return@withContext null

        try {
            org.llamenos.core.mobileDecryptMessage(
                encryptedContent = encryptedContent,
                envelopes = envelopes.map { it.toFfiRecipientEnvelope() },
            )
        } catch (_: org.llamenos.core.CryptoException) {
            null
        }
    }

    // ---- Case records + case comments (sealed per purpose, #2499) ----

    /**
     * Seal a case record's summary or fields, or a case comment, as this device for
     * this device plus [readerPubkeys] (X25519).
     *
     * The label and AAD are not arguments: [org.llamenos.core.mobileSealCase] derives
     * both from [purpose] inside `packages/crypto/src/case_record.rs`. Android used to
     * seal case records as `LABEL_MESSAGE` with no AAD and case comments as notes, so
     * no other platform — and, for comments, not Android itself — could read them.
     */
    suspend fun sealCase(
        purpose: org.llamenos.core.CasePurpose,
        plaintext: String,
        readerPubkeys: List<String>,
    ): EncryptedCase = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            val sealed = org.llamenos.core.mobileSealCase(
                purpose = purpose,
                plaintext = plaintext,
                readerPubkeys = readerPubkeys,
            )
            EncryptedCase(
                ciphertextHex = sealed.encryptedContent,
                envelopes = sealed.readerEnvelopes.map {
                    RecipientEnvelope(pubkey = it.pubkey, enc = it.enc, ct = it.ct)
                },
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Case encryption failed: ${e.message}", e)
        }
    }

    /**
     * Open a case ciphertext as this device. [envelopes] are all of its envelopes as
     * they arrive on the wire; Rust picks the one addressed to this device. Returns
     * null when none is ours — this device is not a reader.
     *
     * An envelope that IS ours but will not open is not "not a reader": it throws,
     * so a writer that sealed in another format surfaces instead of rendering as a
     * silently encrypted row.
     */
    suspend fun openCase(
        purpose: org.llamenos.core.CasePurpose,
        encryptedContent: String,
        envelopes: List<RecipientEnvelope>,
    ): String? = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        val ours = encryptionPubkeyHex ?: return@withContext null
        if (!isUnlocked || envelopes.none { it.pubkey.equals(ours, ignoreCase = true) }) {
            return@withContext null
        }
        try {
            org.llamenos.core.mobileOpenCase(
                purpose = purpose,
                encryptedContent = encryptedContent,
                envelopes = envelopes.map { it.toFfiRecipientEnvelope() },
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Case decryption failed: ${e.message}", e)
        }
    }

    private fun RecipientEnvelope.toFfiRecipientEnvelope() =
        org.llamenos.core.RecipientKeyEnvelope(pubkey = pubkey, enc = enc, ct = ct)

    // ---- PUK Operations ----

    /** Create the initial Per-User Key (generation 1). */
    suspend fun createInitialPuk(): String = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
        try {
            org.llamenos.core.mobileSigchainVerifyLink(linkJson, expectedSignerPubkey)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Sigchain link verification failed: ${e.message}", e)
        }
    }

    /**
     * This device's `device_kem` payload JSON for [userPubkey] (spec §5): its
     * X-Wing key and possession signature, made in Rust. The link carrying it
     * must be signed by this device ([createSigchainLink]).
     */
    suspend fun deviceKemPayload(userPubkey: String): String = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        try {
            org.llamenos.core.mobileDeviceKemPayload(userPubkey)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("device_kem payload failed: ${e.message}", e)
        }
    }

    /**
     * The migration-genesis device set for a hub's members' chains (spec §5):
     * every chain verified together (cross-user key reuse refused), active
     * devices with an X-Wing key in `included`, the rest in `missing`.
     */
    suspend fun genesisDeviceSet(chainsJson: String): org.llamenos.core.GenesisDeviceSet =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
            try {
                org.llamenos.core.mobileGenesisDeviceSet(chainsJson)
            } catch (e: org.llamenos.core.CryptoException) {
                throw CryptoException("Genesis device set refused: ${e.message}", e)
            }
        }

    /** Verify a complete sigchain (all links). */
    suspend fun verifySigchain(
        linksJson: String,
    ): org.llamenos.core.SigchainVerifiedState = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
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

    /**
     * Unwrap a PUK seed sealed to this device. The puk-seed shape binds this
     * device's id, which Rust takes from its own state.
     */
    suspend fun unwrapPukSeed(envelope: HpkeEnvelope): String = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            org.llamenos.core.mobilePukUnwrapSeed(envelope = envelope.toFfi())
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK seed unwrap failed: ${e.message}", e)
        }
    }

    /** Derive PUK subkeys for a given seed + generation (stateless). */
    suspend fun derivePukState(
        seedHex: String,
        generation: Int,
    ): org.llamenos.core.PukState = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        try {
            org.llamenos.core.mobilePukDeriveState(
                seedHex = seedHex,
                generation = generation.toUInt(),
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("PUK state derivation failed: ${e.message}", e)
        }
    }

    // ---- Relay events (spec D9, #2999) ----

    /**
     * Open a relay frame with the key Rust holds for its hub and epoch. The frame's
     * [hubId], [kind] and [epoch] are bound in its AAD, so a frame moved between
     * hubs or kinds does not open. Returns null when it does not open — including
     * a frame of a hub this user holds no key for.
     */
    fun openServerEvent(hubId: String, kind: Int, epoch: Long, payloadHex: String): String? {
        if (!nativeLibLoaded) return null
        return try {
            org.llamenos.core.mobileOpenServerEvent(hubId, kind.toUInt(), epoch.toULong(), payloadHex)
        } catch (_: org.llamenos.core.CryptoException) {
            null
        }
    }

    /**
     * Replace the relay-event keys held in Rust with the server's list — one per
     * (hub, epoch) for the hubs this user belongs to (`GET /api/auth/me`). The
     * keys are held exclusively in Rust, never in JVM memory.
     */
    fun setServerEventKeys(keys: List<org.llamenos.core.ServerEventKey>) {
        NativeCryptoLibrary.require()
        try {
            org.llamenos.core.mobileSetServerEventKeys(keys)
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Failed to set server event keys: ${e.message}", e)
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
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
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
        NativeCryptoLibrary.require()
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
     * Zeroize every cached hub key, leaving the server event keys in place.
     *
     * The Rust store has no per-hub removal, so evicting one hub's key means
     * clearing all of them and reloading the rest — see `HubRepository`.
     */
    fun clearHubKeysOnly() {
        if (nativeLibLoaded) org.llamenos.core.mobileClearHubKeys()
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
            NativeCryptoLibrary.require()
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

    // ---- Shamir Secret Sharing ----

    suspend fun shamirSplit(secretHex: String, total: Int, threshold: Int): List<ShamirShare> =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
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
            NativeCryptoLibrary.require()
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
            NativeCryptoLibrary.require()
            try {
                org.llamenos.core.mobileShamirCommit(share = share.toFfi())
            } catch (e: Exception) {
                throw CryptoException("Shamir commit failed: ${e.message}", e)
            }
        }

    suspend fun shamirVerify(share: ShamirShare, commitment: String): Boolean =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
            try {
                org.llamenos.core.mobileShamirVerify(share = share.toFfi(), commitmentHex = commitment)
            } catch (e: Exception) {
                throw CryptoException("Shamir verify failed: ${e.message}", e)
            }
        }

    // ---- Ban digest (#2759) ----

    /**
     * Blind an E.164 number for a ban digest (RFC 9497 OPRF, `packages/crypto/src/ban_digest.rs`).
     * Send [org.llamenos.core.BanDigestBlind.blindedElementHex] to the server's evaluate endpoint
     * and keep [org.llamenos.core.BanDigestBlind.blindHex] for [banDigestFinalize]: the number
     * itself never leaves the device. Throws for anything that is not E.164.
     */
    suspend fun banDigestBlind(phone: String): org.llamenos.core.BanDigestBlind =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
            try {
                org.llamenos.core.banDigestBlind(phone = phone)
            } catch (e: Exception) {
                throw CryptoException("Ban digest blind failed: ${e.message}", e)
            }
        }

    /** Finalize the server's evaluated element into the number's ban digest (128 hex chars). */
    suspend fun banDigestFinalize(phone: String, blindHex: String, evaluatedElementHex: String): String =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
            try {
                org.llamenos.core.banDigestFinalize(
                    phone = phone,
                    blindHex = blindHex,
                    evaluatedElementHex = evaluatedElementHex,
                )
            } catch (e: Exception) {
                throw CryptoException("Ban digest finalize failed: ${e.message}", e)
            }
        }

    // ---- Recovery Group ----

    suspend fun recoveryGroupGenerateKeypair(): RecoveryGroupKeypair =
        withContext(computeDispatcher) {
            NativeCryptoLibrary.require()
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

    /**
     * Prove this device still holds its recovery share (#2782).
     *
     * [shareEnvelopeJson] is the holder's envelope exactly as
     * `GET /api/recovery-group/shares/my` returns it: the JSON of the crate's
     * `HpkeEnvelope` (base64url `enc`/`ct`, the UniFFI record's own encoding),
     * so it maps onto [org.llamenos.core.HpkeEnvelope] field for field. Rust
     * opens it with the device key, derives the share's liveness key and signs
     * the server's single-use [challengeHex], bound to [hubId] and to this
     * device's own signing pubkey. Returns the proof (hex). Neither the share
     * nor the derived key enters Kotlin.
     */
    suspend fun recoveryShareLivenessProof(
        shareEnvelopeJson: String,
        hubId: String,
        challengeHex: String,
    ): String = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")
        val stored = json.decodeFromString<StoredShareEnvelope>(shareEnvelopeJson)
        try {
            org.llamenos.core.mobileRecoveryShareLivenessProof(
                shareEnvelope = org.llamenos.core.HpkeEnvelope(
                enc = stored.enc,
                    ct = stored.ct,
                ),
                hubId = hubId,
                challengeHex = challengeHex,
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("Recovery share liveness proof failed: ${e.message}", e)
        }
    }

    /** A share envelope as the server stores it — the crate's serialized `HpkeEnvelope`. */
    @kotlinx.serialization.Serializable
    private data class StoredShareEnvelope(val enc: String, val ct: String)

    // ---- Call Metadata Decryption (stored-record format) ----

    /**
     * Decrypt call metadata (callerNumber, answeredBy) from a call record's admin envelopes.
     *
     * Call records are stored records sealed by the server (`encryptCallRecordForStorage`,
     * `PROTOCOL.md` §2.5): empty AAD on both layers. Rust finds this device's envelope and
     * binds the AAD ([org.llamenos.core.mobileDecryptCallMetadata]); this used to open them
     * by hand under the canonical AAD, which the server never wrote, so it always failed.
     * Returns null if no envelope is ours or decryption fails.
     */
    suspend fun decryptCallMetadata(
        encryptedContent: String,
        adminEnvelopes: List<AdminEnvelopeData>,
    ): CallMetadata? = withContext(computeDispatcher) {
        if (!nativeLibLoaded || !isUnlocked) return@withContext null

        try {
            val plaintext = org.llamenos.core.mobileDecryptCallMetadata(
                encryptedContent = encryptedContent,
                envelopes = adminEnvelopes.map {
                    org.llamenos.core.RecipientKeyEnvelope(pubkey = it.pubkey, enc = it.enc, ct = it.ct)
                },
            )
            json.decodeFromString<CallMetadata>(plaintext)
        } catch (_: Exception) {
            null
        }
    }

    // ---- File Encryption (HPKE) ----

    /**
     * Encrypt file data with per-recipient HPKE key wrapping.
     *
     * 1. Seal the file content under a fresh key (the file-key shape)
     * 2. HPKE-seal the file key per recipient (same shape)
     * 3. Seal the metadata JSON per recipient (the file-metadata-key shape)
     */
    suspend fun encryptFile(
        data: ByteArray,
        fileName: String,
        mimeType: String,
        recipientPubkeys: List<String>,
    ): EncryptedFile = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")

        try {
            // SHA-256 checksum of plaintext
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            val checksumBytes = digest.digest(data)
            val checksum = checksumBytes.joinToString("") { "%02x".format(it) }

            // The file's raw bytes under the file-key shape's content AAD —
            // mobileContentSeal returns [ciphertextHex, keyHex]
            val dataHex = data.joinToString("") { "%02x".format(it) }
            val encResult = org.llamenos.core.mobileContentSeal(
                shape = org.llamenos.core.Shape.FILE_KEY,
                plaintextHex = dataHex,
            )
            val encryptedContentHex = encResult[0]
            val fileKeyHex = encResult[1]
            val encryptedContent = hexToBytes(encryptedContentHex)

            // HPKE-wrap file key for each recipient
            val keyEnvelopes = recipientPubkeys.map { pubkey ->
                val env = org.llamenos.core.mobileShapeSeal(
                    shape = org.llamenos.core.Shape.FILE_KEY,
                    recipientPubkeyHex = pubkey,
                    aadFields = emptyList(),
                    plaintextHex = fileKeyHex,
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
                val metaResult = org.llamenos.core.mobileContentSeal(
                    shape = org.llamenos.core.Shape.FILE_METADATA_KEY,
                    plaintextHex = metaHex,
                )
                val encMetaHex = metaResult[0]
                val metaKeyHex = metaResult[1]
                val env = org.llamenos.core.mobileShapeSeal(
                    shape = org.llamenos.core.Shape.FILE_METADATA_KEY,
                    recipientPubkeyHex = pubkey,
                    aadFields = emptyList(),
                    plaintextHex = metaKeyHex,
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
     * Open a file's content key (the file-key shape) addressed to this device.
     */
    suspend fun decryptFileKey(envelope: HpkeEnvelope): String = withContext(computeDispatcher) {
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")
        try {
            org.llamenos.core.mobileShapeOpen(
                shape = org.llamenos.core.Shape.FILE_KEY,
                aadFields = emptyList(),
                envelope = envelope.toFfi(),
            )
        } catch (e: org.llamenos.core.CryptoException) {
            throw CryptoException("File key decryption failed: ${e.message}", e)
        }
    }

    /**
     * Open one file-metadata entry (the file-metadata-key shape) addressed to this device.
     */
    suspend fun decryptFileMetadata(
        encryptedContentHex: String,
        envelope: HpkeEnvelope,
    ): FileMetadata? = withContext(computeDispatcher) {
        if (!nativeLibLoaded || !isUnlocked) return@withContext null

        try {
            val plaintextHex = org.llamenos.core.mobileOpenSealedContent(
                shape = org.llamenos.core.Shape.FILE_METADATA_KEY,
                ciphertextHex = encryptedContentHex,
                envelope = envelope.toFfi(),
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
        NativeCryptoLibrary.require()
        if (!isUnlocked) throw CryptoException("No key loaded")

        try {
            val plaintextHex = org.llamenos.core.mobileContentOpen(
                shape = org.llamenos.core.Shape.FILE_KEY,
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
            NativeCryptoLibrary.require()
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
            NativeCryptoLibrary.require()
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
// fleet-review base refresh 2026-10-05
