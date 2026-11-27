package org.llamenos.hotline.service

import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.model.RegisterDeviceRequest
import org.llamenos.protocol.AppendSigchainLinkBody
import org.llamenos.protocol.DistributePukEnvelopesBody
import org.llamenos.protocol.DistributePukEnvelopesBodyEnvelope
import org.llamenos.protocol.SharedAuthorEnvelope
import org.llamenos.protocol.SigchainLinkType
import org.llamenos.protocol.SigchainResponseLink
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Registers this device's identity keys with the server.
 *
 * The server seals records (inbound messages, call metadata) to the
 * `devices.x25519_pubkey` it holds for a user, so a device that never reached
 * `POST /api/devices/register` is invisible to it: nothing is sealed to the
 * phone however the rest of the pipeline behaves. Identity registration is
 * therefore part of enrolment and unlock, and independent of push — a phone
 * with no UnifiedPush distributor installed (the default) still has keys to
 * register. [PushRegistrationManager] attaches the push endpoint to the same
 * server-side device later, when a distributor assigns one.
 *
 * It also brings the device's sigchain identity up to date ([ensureIdentity]):
 * the user's genesis and first PUK when the chain is still empty (PROTOCOL.md
 * §2.11) — the genesis naming this device's X-Wing key with its possession
 * signature (spec 2026-11-25-v2-device-linking-and-recovery §5 as revised
 * 2026-11-26, #2496) — then verification that the chain authorises this device
 * under the X-Wing key it holds. The key is fixed for the device's life: a chain
 * naming another key for it is reported, never re-keyed (re-keying is
 * remove-and-relink, L6).
 *
 * Multi-hub axiom: registration is per-device, not per-hub; nothing here
 * reads or depends on the active hub.
 */
@Singleton
class DeviceRegistrationManager @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val keyValueStore: KeyValueStore,
    @ApplicationScope private val scope: CoroutineScope,
) {

    private val mutex = Mutex()

    /** The keys last accepted by the server in this process; the server may have been reset since, so never persisted. */
    private var registeredKeys: Pair<String, String>? = null

    /**
     * Fire-and-forget form for the login/unlock paths. A failure leaves the
     * device unregistered and is retried by the next call (every unlock).
     */
    fun ensureRegistered() {
        scope.launch {
            register()
            ensureIdentity()
        }
    }

    /**
     * Register the device keys unless this process already did for these
     * exact keys. Fails when the keys are locked or the server refuses or
     * cannot be reached — the caller decides how loudly to surface that.
     */
    suspend fun register(): Result<Unit> = mutex.withLock {
        val ed25519 = cryptoService.signingPubkeyHex
        val x25519 = cryptoService.encryptionPubkeyHex
        if (ed25519 == null || x25519 == null) {
            return@withLock Result.failure(IllegalStateException("Device keys are locked"))
        }
        if (registeredKeys == (ed25519 to x25519)) return@withLock Result.success(Unit)
        try {
            apiService.registerDevice(
                RegisterDeviceRequest(
                    ed25519Pubkey = ed25519,
                    x25519Pubkey = x25519,
                    deviceModel = Build.MODEL,
                    osVersion = Build.VERSION.RELEASE,
                ),
            )
            registeredKeys = ed25519 to x25519
            Result.success(Unit)
        } catch (e: Exception) {
            Log.w(TAG, "Device identity registration failed: ${e.message}")
            Result.failure(e)
        }
    }

    private val identityMutex = Mutex()

    /** The X-Wing key the server's chain was last verified to name for this device, this process. */
    private var verifiedKemKey: String? = null

    /**
     * Bring this device's sigchain identity up to date: genesis + PUK generation 1
     * + puk_epoch if the user's chain is empty and this is the user's identity
     * device, then verification that the chain authorises this device under the
     * X-Wing key it holds. Idempotent. A failure is logged loudly and retried by
     * the next unlock — never skipped silently.
     */
    suspend fun ensureIdentity(): Result<Unit> = identityMutex.withLock {
        val user = cryptoService.signingPubkeyHex
        val kem = cryptoService.kemPubkeyHex
        if (user == null || kem == null) {
            return@withLock Result.failure(IllegalStateException("Device keys are locked or have no X-Wing key"))
        }
        if (verifiedKemKey == kem) return@withLock Result.success(Unit)
        try {
            var links = apiService.getSigchain(user).links
            val known = verifiedHead(user)
            if (known != null) {
                // Never take a server's word that the chain shrank: a chain that
                // does not extend the head this device verified is a rollback or a
                // fork, and re-initialising it would sign a second genesis.
                val at = links.getOrNull(known.first - 1)
                if (at == null || at.hash != known.second) {
                    throw IllegalStateException("The server's sigchain does not extend the head this device verified")
                }
            } else if (links.isEmpty()) {
                links = initialiseIdentity(user)
            }
            val verified = cryptoService.verifySigchain(cryptoLinksJson(links))
            if (verified.userPubkey != user || !verified.activeDevicePubkeys.contains(user)) {
                throw IllegalStateException("Verified sigchain does not authorise this device")
            }
            recordHead(user, verified)
            if (verified.activeDeviceKeys.none { it.devicePubkey == user && it.encryptionPubkey == kem }) {
                throw IllegalStateException(
                    "The verified sigchain names a different X-Wing key for this device than the one it holds",
                )
            }
            verifiedKemKey = kem
            Result.success(Unit)
        } catch (e: Exception) {
            Log.e(TAG, "Device identity verification failed: ${e.message}", e)
            Result.failure(e)
        }
    }

    /**
     * The (seq, hash) of [user]'s chain head this device last verified, or null
     * only when none was ever recorded. Fails closed: a malformed value or another
     * user's head throws — "no head" is what lets an empty chain be initialised.
     */
    private fun verifiedHead(user: String): Pair<Int, String>? {
        val stored = keyValueStore.retrieve(KeystoreService.KEY_SIGCHAIN_HEAD) ?: return null
        val parts = stored.split(':')
        val seq = parts.getOrNull(1)?.toIntOrNull()
        if (parts.size != 3 || parts[0] != user || seq == null) {
            throw IllegalStateException("The sigchain head this device recorded cannot be read")
        }
        return seq to parts[2]
    }

    private fun recordHead(user: String, verified: org.llamenos.core.SigchainVerifiedState) {
        keyValueStore.store(KeystoreService.KEY_SIGCHAIN_HEAD, "$user:${verified.headSeq}:${verified.headHash}")
    }

    /** Genesis + PUK generation 1 + puk_epoch, in the order PROTOCOL.md §2.11 fixes. */
    private suspend fun initialiseIdentity(user: String): List<SigchainResponseLink> {
        val deviceId = cryptoService.deviceId ?: throw IllegalStateException("Device keys are locked")
        // Built in Rust: the device's keys, its X-Wing key and the pop over it.
        val genesis = Json.parseToJsonElement(cryptoService.userInitPayload()).jsonObject
        appendSigned(user, SigchainLinkType.Genesis, genesis, null)
        // The envelope is stored BEFORE the chain claims the PUK, so a chain never
        // names a PUK whose seed was lost.
        val puk = Json.parseToJsonElement(cryptoService.createInitialPuk()).jsonObject
        val pukState = puk.getValue("pukState").jsonObject
        val envelope = puk.getValue("envelope").jsonObject
        val generation = pukState.getValue("generation").jsonPrimitive.int
        apiService.distributePukEnvelopes(
            DistributePukEnvelopesBody(
                listOf(
                    DistributePukEnvelopesBodyEnvelope(
                        deviceID = deviceId,
                        envelope = SharedAuthorEnvelope(
                            ct = envelope.getValue("ct").jsonPrimitive.content,
                            enc = envelope.getValue("enc").jsonPrimitive.content,
                        ),
                        generation = generation,
                    ),
                ),
            ),
        )
        val epoch = buildJsonObject {
            put("type", "puk_epoch")
            put("generation", generation)
            put("signPubkey", pukState.getValue("signPubkeyHex").jsonPrimitive.content)
            put("dhPubkey", pukState.getValue("dhPubkeyHex").jsonPrimitive.content)
        }
        appendSigned(user, SigchainLinkType.PukEpoch, epoch, apiService.getSigchain(user).links.last())
        return apiService.getSigchain(user).links
    }

    /** Sign [payload] in Rust as the link after [head] and append it to the user's chain. */
    private suspend fun appendSigned(
        user: String,
        type: SigchainLinkType,
        payload: JsonObject,
        head: SigchainResponseLink?,
    ) {
        val seq = (head?.seqNo ?: 0) + 1
        val timestamp = java.time.Instant.now().toString()
        val link = cryptoService.createSigchainLink(
            id = java.util.UUID.randomUUID().toString(),
            seq = seq.toLong(),
            prevHash = head?.hash,
            timestamp = timestamp,
            payloadJson = payload.toString(),
        )
        apiService.appendSigchainLink(
            user,
            AppendSigchainLinkBody(
                hash = link.entryHash,
                linkType = type,
                payload = payload,
                seqNo = seq,
                signature = link.signature,
                signerDeviceID = link.signerDeviceId,
                signerPubkey = link.signerPubkey,
                timestamp = timestamp,
                prevHash = head?.hash,
            ),
        )
    }

    /** The server's links in the crate's `SigchainLink` JSON shape. */
    private fun cryptoLinksJson(links: List<SigchainResponseLink>): String = buildJsonArray {
        for (l in links) {
            add(
                buildJsonObject {
                    put("id", l.id)
                    put("seq", l.seqNo)
                    put("prevHash", l.prevHash?.takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
                    put("entryHash", l.hash)
                    put("signerDeviceId", l.signerDeviceID)
                    put("signerPubkey", l.signerPubkey)
                    put("signature", l.signature)
                    put("timestamp", l.timestamp)
                    put("payloadJson", (l.payload ?: kotlinx.serialization.json.JsonNull).toString())
                },
            )
        }
    }.toString()

    private companion object {
        const val TAG = "DeviceRegistration"
    }
}
