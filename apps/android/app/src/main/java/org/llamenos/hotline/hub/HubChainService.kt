package org.llamenos.hotline.hub

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.protocol.ChainHead
import org.llamenos.protocol.HubChainVerified
import org.llamenos.protocol.HubFoundingResponse
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The hub authority chain on Android (#2963; wire spec §5, #2974 items 3–5).
 *
 * - **Load:** fetch the hub's chain and verify it in Rust (`hub_chain::call`
 *   `verify`, through [CryptoService.hubChainCall]) with the user chains of its
 *   signers, against the trusted anchor this device holds. Links stay raw JSON
 *   from the response into the crate — no Kotlin type decodes them, so no signed
 *   field can be dropped.
 * - **Anchor:** `{hub, seq, hash}` comes from this device only (its own genesis,
 *   its own previous verification), never from the server. A chain that does not
 *   contain it is a fork.
 * - **Alerts:** fork, refused (unauthorised or otherwise invalid link) and the
 *   advisory stale-signer finding (D13). **Only a verified chain seals**
 *   ([assertSealable]); a fork, a refused or missing chain, or a failed fetch all
 *   stop sealing in that hub.
 *
 * Nothing here canonicalises, hashes or checks a link — every such step is the crate's.
 */
@Singleton
class HubChainService @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val keyValueStore: KeyValueStore,
) {
    sealed interface Status {
        data class Verified(
            val seq: Int,
            val hash: String,
            val staleSigners: Int,
            val at: Long = System.currentTimeMillis(),
        ) : Status
        /** The server serves no chain for the hub. */
        data object None : Status
        data class Fork(val detail: String) : Status
        data class Refused(val code: String, val detail: String) : Status
    }

    class SealingStoppedException(val hubId: String) :
        IllegalStateException("Sealing is stopped in hub $hubId: its authority chain is not verified")

    private val json = Json { ignoreUnknownKeys = true }
    private val anchorLock = Mutex()
    private val _statuses = MutableStateFlow<Map<String, Status>>(emptyMap())
    private val _verified = MutableStateFlow<Map<String, HubChainVerified>>(emptyMap())

    /** Every hub's latest verdict (the alert banner observes the active hub's). */
    val statuses: StateFlow<Map<String, Status>> = _statuses.asStateFlow()

    /** The crate's verified answer per hub, from this device's last successful verification. */
    val verified: StateFlow<Map<String, HubChainVerified>> = _verified.asStateFlow()

    private fun record(hubId: String, status: Status): Status {
        _statuses.value = _statuses.value + (hubId to status)
        return status
    }

    // ── Anchors ──

    /** Fails closed: an unreadable stored value throws — it is never "no anchors". */
    private fun anchors(): Map<String, ChainHead> {
        val raw = keyValueStore.retrieve(KEY_ANCHORS) ?: return emptyMap()
        return json.decodeFromString<Map<String, ChainHead>>(raw)
    }

    private suspend fun anchor(hubId: String): ChainHead? = anchorLock.withLock { anchors()[hubId] }

    /** A head that would move the anchor backwards or sideways (wire spec §5.7). */
    class AnchorForkException(message: String) : IllegalStateException(message)

    /**
     * Advance the anchor for [hubId] under the wire spec §5.7 rule: strictly
     * forward. A lower seq is refused and an equal seq with a different hash is a
     * fork — both throw [AnchorForkException]. The caller holds the hub's queue.
     */
    suspend fun advanceAnchor(hubId: String, head: ChainHead) = anchorLock.withLock {
        val all = anchors()
        val known = all[hubId]
        if (known != null) {
            if (head.seq < known.seq) {
                throw AnchorForkException("the verified head seq ${head.seq} is below the anchor at seq ${known.seq}")
            }
            if (head.seq == known.seq) {
                if (head.hash != known.hash) throw AnchorForkException("a different link at the anchored seq ${known.seq}")
                return@withLock
            }
        }
        keyValueStore.store(KEY_ANCHORS, json.encodeToString(all + (hubId to head)))
    }

    // ── One entry point per hub (wire spec §5.7) ──

    private val queuesLock = Mutex()
    private val queues = mutableMapOf<String, Mutex>()
    private val inFlight = mutableMapOf<String, Deferred<Status>>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Run [step] alone for [hubId]: a verification and every append that moves the anchor are one critical section. */
    private suspend fun <T> serialised(hubId: String, step: suspend () -> T): T {
        val mutex = queuesLock.withLock { queues.getOrPut(hubId) { Mutex() } }
        return mutex.withLock { step() }
    }

    // ── Load ──

    /** Every link, as the server's raw JSON. Pages are contiguous from seq 1. */
    private suspend fun fetchLinks(hubId: String): List<JsonElement> {
        val links = mutableListOf<JsonElement>()
        while (true) {
            val page = apiService.request<JsonObject>("GET", apiService.hubPath(hubId, "/api/chain?from=${links.size + 1}"))
            val pageLinks = page["links"]?.jsonArray ?: JsonArray(emptyList())
            links.addAll(pageLinks)
            val hasMore = page["hasMore"]?.jsonPrimitive?.content == "true"
            if (!hasMore || pageLinks.isEmpty()) return links
        }
    }

    private suspend fun crate(request: JsonObject): String = cryptoService.hubChainCall(request.toString())

    @Serializable
    private data class UsersNamed(val users: List<String>)

    /** Each user chain the crate says a verifier of [links] needs, as the server serves it. */
    private suspend fun userChains(links: List<JsonElement>): JsonArray {
        val named = json.decodeFromString<UsersNamed>(crate(buildJsonObject { put("op", "usersNamed"); put("links", JsonArray(links)) }))
        return buildJsonArray {
            for (u in named.users) {
                val served = apiService.request<JsonObject>("GET", "/api/users/$u/sigchain")["links"]?.jsonArray
                if (served != null && served.isNotEmpty()) add(served)
            }
        }
    }

    /**
     * Fetch and verify [hubId]'s chain against this device's anchor; advance it.
     * The one entry point (wire spec §5.7): every caller shares a verification
     * already in flight for the hub.
     */
    suspend fun load(hubId: String): Status {
        val pending = queuesLock.withLock {
            inFlight[hubId] ?: scope.async {
                try {
                    serialised(hubId) { loadNow(hubId) }
                } finally {
                    queuesLock.withLock { inFlight.remove(hubId) }
                }
            }.also { inFlight[hubId] = it }
        }
        return pending.await()
    }

    private suspend fun loadNow(hubId: String): Status {
        val links = fetchLinks(hubId)
        val anchor = anchor(hubId)
        if (links.isEmpty()) {
            return record(hubId, if (anchor != null) Status.Fork("the server serves no chain, but this device verified one") else Status.None)
        }
        val request = buildJsonObject {
            put("op", "verify")
            put("links", JsonArray(links))
            put("userChains", userChains(links))
            if (anchor != null) put("anchor", json.encodeToJsonElement(ChainHead.serializer(), anchor))
        }
        return try {
            val verified = json.decodeFromString<HubChainVerified>(crate(request))
            // A valid chain of ANOTHER hub, served for this one, is refused.
            if (verified.hub != hubId) return record(hubId, Status.Refused("chain_hub_mismatch", "the served chain is hub ${verified.hub}'s"))
            advanceAnchor(hubId, verified.head)
            _verified.value = _verified.value + (hubId to verified)
            record(hubId, Status.Verified(verified.head.seq, verified.head.hash, verified.alerts.size))
        } catch (e: AnchorForkException) {
            record(hubId, Status.Fork(e.message ?: "chain_fork"))
        } catch (e: kotlinx.serialization.SerializationException) {
            record(hubId, Status.Refused("invalid_input", "unreadable crate answer"))
        } catch (e: CryptoException) {
            val code = rejectionCode(e)
            record(hubId, if (code == "chain_fork") Status.Fork(e.message ?: code) else Status.Refused(code, e.message ?: code))
        }
    }

    /**
     * Refuse to seal in [hubId] unless this device has VERIFIED its chain. With no
     * verdict (or only "no chain", which a server could claim for any hub) the
     * chain is loaded first; a fetch failure throws — "could not check" is not "checked".
     */
    suspend fun assertSealable(hubId: String) {
        var status = _statuses.value[hubId]
        // A verification is good for VERIFIED_TTL_MS: after that, sealing re-checks
        // the chain (a fork served since is caught), and a failed re-check refuses.
        val fresh = status is Status.Verified && System.currentTimeMillis() - status.at < VERIFIED_TTL_MS
        if (!fresh && status !is Status.Fork && status !is Status.Refused) status = load(hubId)
        if (status !is Status.Verified) throw SealingStoppedException(hubId)
    }

    // ── Writing: every link is built from intent in the crate (#3133) ──

    @Serializable
    private data class VerifiedHead(val activeDevicePubkeys: List<String>, val headSeq: Int, val headHash: String)

    private suspend fun ownHead(user: String): ChainHead {
        val served = apiService.request<JsonObject>("GET", "/api/users/$user/sigchain")["links"] ?: JsonArray(emptyList())
        val state = json.decodeFromString<VerifiedHead>(crate(buildJsonObject { put("op", "verifySigchain"); put("links", served) }))
        val device = cryptoService.signingPubkeyHex ?: error("Device is locked")
        check(device in state.activeDevicePubkeys) { "This device is not active in its user chain" }
        return ChainHead(hash = state.headHash, seq = state.headSeq)
    }

    /** A link the crate signed — passed on to the server as is, never read — and the head it makes. */
    private class Signed(val link: JsonElement, val head: ChainHead)

    private suspend fun sign(hubId: String, prev: ChainHead?, signer: String, signerHead: ChainHead, intent: JsonObject): Signed {
        val request = buildJsonObject {
            put("hub", hubId)
            put("prev", prev?.let { json.encodeToJsonElement(ChainHead.serializer(), it) } ?: JsonNull)
            put("signerUser", signer)
            put("signerUserHead", json.encodeToJsonElement(ChainHead.serializer(), signerHead))
            put("intent", intent)
        }
        val answer = json.parseToJsonElement(cryptoService.signHubIntent(request.toString())).jsonObject
        return Signed(answer.getValue("link"), json.decodeFromJsonElement(ChainHead.serializer(), answer.getValue("head")))
    }

    private suspend fun append(hubId: String, signed: Signed) {
        apiService.request<JsonObject>("POST", apiService.hubPath(hubId, "/api/chain"), buildJsonObject { put("link", signed.link) })
    }

    /** The chain write was refused before signing: this device has not verified the hub's chain. */
    class WriteRefusedException(val hubId: String, val status: Status) :
        IllegalStateException("This device cannot write to hub $hubId's authority chain ($status)")

    /**
     * Sign and append the links [intents] names, as this user, on the head this
     * device has just verified (§5.1): verify, decide against the verified state,
     * sign each through the crate, append. A lost race (409) re-reads,
     * re-verifies, re-decides and re-signs. Every role write takes this path; the
     * server has no unsigned role write (#3133).
     */
    suspend fun appendIntents(hubId: String, intents: (HubChainVerified) -> List<JsonObject>): HubChainVerified {
        val signer = cryptoService.signingPubkeyHex ?: error("Device is locked")
        return serialised(hubId) {
            var result: HubChainVerified? = null
            for (attempt in 1..APPEND_ATTEMPTS) {
                val status = loadNow(hubId)
                val verified = _verified.value[hubId]
                if (status !is Status.Verified || verified == null) throw WriteRefusedException(hubId, status)
                val wanted = intents(verified)
                if (wanted.isEmpty()) { result = verified; break }
                val signerHead = ownHead(signer)
                var prev = verified.head
                try {
                    for (intent in wanted) {
                        val signed = sign(hubId, prev, signer, signerHead, intent)
                        append(hubId, signed)
                        advanceAnchor(hubId, signed.head)
                        prev = signed.head
                    }
                } catch (e: ApiException) {
                    if (e.code == 409 && attempt < APPEND_ATTEMPTS) continue
                    throw e
                }
                val after = loadNow(hubId)
                result = _verified.value[hubId]
                if (after !is Status.Verified || result == null) throw WriteRefusedException(hubId, after)
                break
            }
            result ?: throw WriteRefusedException(hubId, Status.None)
        }
    }

    // ── Founding (new-hub genesis, §5.6) ──

    /**
     * Found a hub: this device signs its genesis (the founder alone, holding the
     * founder bundles the server's catalog names), the server stores it as the
     * chain's first link, then each bundle's permissions are committed in a
     * `policy {kind: bundle}` link — every link built in the crate from its intent.
     */
    suspend fun foundHub(fields: JsonObject) {
        val founder = cryptoService.signingPubkeyHex ?: error("Device is locked")
        val founding = apiService.request<HubFoundingResponse>("GET", "/api/hubs/founding")
        val head = ownHead(founder)
        val hubId = java.util.UUID.randomUUID().toString().lowercase()
        val genesis = sign(hubId, null, founder, head, buildJsonObject {
            put("type", "genesis")
            put("bundles", JsonArray(founding.bundles.map { JsonPrimitive(it.bundle) }))
        })
        val body = JsonObject(fields + mapOf("id" to JsonPrimitive(hubId), "genesis" to genesis.link))
        apiService.request<JsonObject>("POST", "/api/hubs", body)
        serialised(hubId) {
            advanceAnchor(hubId, genesis.head)
            var prev = genesis.head
            for (b in founding.bundles) {
                val link = sign(hubId, prev, founder, head, buildJsonObject {
                    put("type", "bundlePolicy")
                    put("bundle", b.bundle)
                    put("permissions", JsonArray(b.permissions.map(::JsonPrimitive)))
                })
                append(hubId, link)
                advanceAnchor(hubId, link.head)
                prev = link.head
            }
        }
    }

    companion object {
        private const val KEY_ANCHORS = "hub-chain-anchors"
        private const val VERIFIED_TTL_MS = 5 * 60 * 1000L
        private const val APPEND_ATTEMPTS = 3

        /** The crate's closed rejection code of an error (`chain_fork`, …). */
        fun rejectionCode(e: Throwable): String {
            val message = (e.cause?.message ?: "") + " " + (e.message ?: "")
            return Regex("""(?:hub chain|sigchain) rejected \(([a-z_]+)\)""").find(message)?.groupValues?.get(1)
                ?: "invalid_input"
        }
    }
}
