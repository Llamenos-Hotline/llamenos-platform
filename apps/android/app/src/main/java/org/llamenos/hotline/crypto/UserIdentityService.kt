package org.llamenos.hotline.crypto

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.protocol.AppendSigchainLinkBody
import org.llamenos.protocol.DistributePukEnvelopesBody
import org.llamenos.protocol.DistributePukEnvelopesBodyEnvelope
import org.llamenos.protocol.DistributePukEnvelopesResponse
import org.llamenos.protocol.SigchainGenesisPayload
import org.llamenos.protocol.SigchainGenesisPayloadType
import org.llamenos.protocol.SigchainLinkRecord
import org.llamenos.protocol.SigchainLinkType
import org.llamenos.protocol.SigchainPukEpochPayload
import org.llamenos.protocol.SigchainPukEpochPayloadType
import org.llamenos.protocol.SigchainResponse
import org.llamenos.protocol.SigchainResponseLink
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * User identity initialisation — the sigchain genesis link and the first PUK
 * (docs/protocol/PROTOCOL.md §2.11 "Identity initialisation").
 *
 * Produces, for the user whose identity key is this device's Ed25519 key:
 *
 *   1. seq 1 `genesis` link (payload `user_init`) naming this device's Ed25519 +
 *      X25519 keys, signed by this device.
 *   2. PUK generation 1, HPKE-sealed to this device (LABEL_PUK_WRAP_TO_DEVICE,
 *      AAD `<label>:<deviceId>`), stored at POST /api/puk/envelopes BEFORE the chain
 *      claims it, so the chain never names a PUK whose seed was lost.
 *   3. seq 2 `puk_epoch` link binding the PUK's public keys into the chain.
 *   4. The chain as the server stores it, re-verified with packages/crypto
 *      `verify_sigchain`, which must authorise this device.
 *
 * Mobile creates device keys before the server knows the user: an admin registers
 * the user's pubkey out of band. Until then every identity route answers 401, so
 * initialisation runs at the first authenticated session — after onboarding and
 * after each unlock — and is idempotent: every step is keyed off the server's
 * current chain, so a retry after a partial failure resumes where it stopped.
 */
/** Starts user identity initialisation for the unlocked device (see [UserIdentityService]). */
interface UserIdentityInitializer {
    /** Initialise (or resume) the identity off the caller's lifecycle; never throws. */
    fun ensureInitializedInBackground()
}

@Singleton
class UserIdentityService @Inject constructor(
    private val cryptoService: CryptoService,
    private val apiService: ApiService,
    @ApplicationScope private val appScope: CoroutineScope,
) : UserIdentityInitializer {
    /** Result of an initialisation attempt. */
    sealed interface Outcome {
        /** The server's chain verifies and authorises this device. */
        data class Verified(val state: org.llamenos.core.SigchainVerifiedState) : Outcome

        /** The server does not know this user yet (401) — retried at the next session. */
        data object NotRegistered : Outcome
    }

    private val mutex = Mutex()
    private val json = Json { encodeDefaults = true; explicitNulls = false; ignoreUnknownKeys = true }

    /**
     * Run [ensureInitialized] on the application scope, so leaving the screen that
     * started it cannot cancel a half-written identity. Failures are logged; the next
     * session resumes from the server's chain.
     */
    override fun ensureInitializedInBackground() {
        appScope.launch {
            try {
                when (val outcome = ensureInitialized()) {
                    is Outcome.Verified -> Log.i(TAG, "Identity verified at seq ${outcome.state.headSeq}")
                    Outcome.NotRegistered -> Log.i(TAG, "User not registered yet — identity deferred")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Identity initialisation failed", e)
            }
        }
    }

    /**
     * Create the user's sigchain genesis link and first PUK if they are missing, then
     * verify the stored chain. Serialised so two sessions cannot race on seq numbers.
     */
    suspend fun ensureInitialized(): Outcome = mutex.withLock {
        if (!cryptoService.isUnlocked) throw CryptoException("Device keys are not unlocked")
        val userPubkey = cryptoService.signingPubkeyHex ?: throw CryptoException("No signing key loaded")
        val deviceId = cryptoService.deviceId ?: throw CryptoException("No device ID loaded")
        val encryptionPubkey = cryptoService.encryptionPubkeyHex
            ?: throw CryptoException("No encryption key loaded")

        var links = try {
            getSigchain(userPubkey)
        } catch (e: ApiException) {
            if (e.code == 401) return@withLock Outcome.NotRegistered
            throw e
        }

        if (links.isEmpty()) {
            val genesis = SigchainGenesisPayload(
                deviceEncryptionPubkey = encryptionPubkey,
                deviceID = deviceId,
                devicePubkey = userPubkey,
                type = SigchainGenesisPayloadType.UserInit,
            )
            appendSignedLink(userPubkey, SigchainLinkType.Genesis, json.encodeToJsonElement(genesis).jsonObject, null)
            links = getSigchain(userPubkey)
        }

        val genesisPayload = json.decodeFromJsonElement(
            SigchainGenesisPayload.serializer(),
            links.first().payload ?: throw CryptoException("Genesis link has no payload"),
        )
        if (genesisPayload.deviceID != deviceId) {
            throw CryptoException("This user's sigchain was created by another device")
        }

        if (links.none { it.linkType == SigchainLinkType.PukEpoch.value }) {
            val puk = cryptoService.createInitialPuk()
            apiService.request<DistributePukEnvelopesResponse>(
                "POST",
                "/api/puk/envelopes",
                DistributePukEnvelopesBody(
                    envelopes = listOf(
                        DistributePukEnvelopesBodyEnvelope(
                            deviceID = deviceId,
                            envelope = puk.envelope,
                            generation = puk.generation,
                        ),
                    ),
                ),
            )
            val epoch = SigchainPukEpochPayload(
                dhPubkey = puk.dhPubkeyHex,
                generation = puk.generation,
                signPubkey = puk.signPubkeyHex,
                type = SigchainPukEpochPayloadType.PukEpoch,
            )
            appendSignedLink(userPubkey, SigchainLinkType.PukEpoch, json.encodeToJsonElement(epoch).jsonObject, links.last())
            links = getSigchain(userPubkey)
        }

        val verified = cryptoService.verifySigchain(toCryptoLinksJson(links))
        if (userPubkey !in verified.activeDevicePubkeys) {
            throw CryptoException("Verified sigchain does not authorise this device")
        }
        Outcome.Verified(verified)
    }

    private suspend fun getSigchain(userPubkey: String): List<SigchainResponseLink> =
        apiService.request<SigchainResponse>("GET", "/api/users/$userPubkey/sigchain").links

    /** Sign [payload] as the link after [head] and append it to the user's chain. */
    private suspend fun appendSignedLink(
        userPubkey: String,
        linkType: SigchainLinkType,
        payload: JsonObject,
        head: SigchainResponseLink?,
    ): SigchainLinkRecord {
        val seqNo = head?.let { it.seqNo + 1 } ?: SIGCHAIN_GENESIS_SEQ
        val timestamp = Instant.now().toString()
        val signed = cryptoService.createSigchainLink(
            id = UUID.randomUUID().toString(),
            seq = seqNo.toLong(),
            prevHash = head?.hash,
            timestamp = timestamp,
            payloadJson = json.encodeToString(JsonObject.serializer(), payload),
        )
        return apiService.request<SigchainLinkRecord>(
            "POST",
            "/api/users/$userPubkey/sigchain",
            AppendSigchainLinkBody(
                hash = signed.entryHash,
                linkType = linkType,
                payload = payload,
                prevHash = head?.hash ?: "",
                seqNo = seqNo,
                signature = signed.signature,
                signerDeviceID = signed.signerDeviceId,
                signerPubkey = signed.signerPubkey,
                timestamp = timestamp,
            ),
        )
    }

    /** Map server link records to the packages/crypto `SigchainLink` JSON `verify_sigchain` takes. */
    internal fun toCryptoLinksJson(links: List<SigchainResponseLink>): String =
        json.encodeToString(
            JsonElement.serializer(),
            buildJsonArray {
                for (link in links) {
                    add(
                        buildJsonObject {
                            put("id", link.id)
                            put("seq", link.seqNo)
                            put("prevHash", link.prevHash.ifEmpty { null })
                            put("entryHash", link.hash)
                            put("signerDeviceId", link.signerDeviceID)
                            put("signerPubkey", link.signerPubkey)
                            put("signature", link.signature)
                            put("timestamp", link.timestamp)
                            put("payloadJson", json.encodeToString(JsonElement.serializer(), link.payload ?: JsonNull))
                        },
                    )
                }
            },
        )

    companion object {
        private const val TAG = "UserIdentityService"

        /**
         * Sequence number of the genesis link — packages/protocol `SIGCHAIN_GENESIS_SEQ`,
         * matching packages/crypto `verify_sigchain`, which requires the first link at seq 1.
         */
        const val SIGCHAIN_GENESIS_SEQ = 1
    }
}
