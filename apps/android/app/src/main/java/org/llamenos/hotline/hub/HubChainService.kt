package org.llamenos.hotline.hub

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.protocol.SigchainResponseLink
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
        data class Verified(val seq: Int, val hash: String, val staleSigners: Int) : Status
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

    /** Every hub's latest verdict (the alert banner observes the active hub's). */
    val statuses: StateFlow<Map<String, Status>> = _statuses.asStateFlow()

    private fun record(hubId: String, status: Status): Status {
        _statuses.value = _statuses.value + (hubId to status)
        return status
    }

    // ── Anchors ──

    /** Fails closed: an unreadable stored value throws — it is never "no anchors". */
    private fun anchors(): JsonObject {
        val raw = keyValueStore.retrieve(KEY_ANCHORS) ?: return JsonObject(emptyMap())
        return json.parseToJsonElement(raw).jsonObject
    }

    private suspend fun anchor(hubId: String): JsonObject? = anchorLock.withLock {
        anchors()[hubId]?.jsonObject
    }

    /** Advance the anchor for [hubId] — never backwards — under the lock. */
    suspend fun setAnchor(hubId: String, seq: Int, hash: String) = anchorLock.withLock {
        val all = anchors()
        val known = all[hubId]?.jsonObject?.get("seq")?.jsonPrimitive?.int
        if (known != null && known > seq) return@withLock
        val next = JsonObject(all + (hubId to buildJsonObject { put("seq", seq); put("hash", hash) }))
        keyValueStore.store(KEY_ANCHORS, next.toString())
    }

    // ── Load ──

    private suspend fun fetchLinks(hubId: String): List<JsonElement> {
        val links = mutableListOf<JsonElement>()
        var from = 1
        while (true) {
            val page = apiService.request<JsonObject>("GET", apiService.hubPath(hubId, "/api/chain?from=$from"))
            val pageLinks = page["links"]?.jsonArray ?: JsonArray(emptyList())
            links.addAll(pageLinks)
            val hasMore = page["hasMore"]?.jsonPrimitive?.content == "true"
            val last = pageLinks.lastOrNull()?.jsonObject?.get("seq")?.jsonPrimitive?.int
            if (!hasMore || last == null) return links
            from = last + 1
        }
    }

    private suspend fun userChains(links: List<JsonElement>): JsonArray {
        val users = sortedSetOf<String>()
        for (l in links.map { it.jsonObject }) {
            l["signerUser"]?.jsonPrimitive?.content?.let(users::add)
            val body = l["body"]?.jsonObject
            if (body?.get("type")?.jsonPrimitive?.content == "recovery_group") {
                body["holders"]?.jsonArray?.forEach { users.add(it.jsonPrimitive.content) }
            }
        }
        return buildJsonArray {
            for (u in users) {
                val chain = apiService.getSigchain(u).links
                if (chain.isNotEmpty()) add(cryptoSigchainLinks(chain))
            }
        }
    }

    /** Fetch and verify [hubId]'s chain against this device's anchor; advance it. */
    suspend fun load(hubId: String): Status {
        val links = fetchLinks(hubId)
        val anchor = anchor(hubId)
        if (links.isEmpty()) {
            return record(hubId, if (anchor != null) Status.Fork("the server serves no chain, but this device verified one") else Status.None)
        }
        val request = buildJsonObject {
            put("op", "verify")
            put("links", JsonArray(links))
            put("userChains", userChains(links))
            if (anchor != null) put("anchor", anchor)
        }
        return try {
            val verified = json.parseToJsonElement(cryptoService.hubChainCall(request.toString())).jsonObject
            val hub = verified["hub"]?.jsonPrimitive?.content
            val head = verified["head"]?.jsonObject
            val seq = head?.get("seq")?.jsonPrimitive?.int
            val hash = head?.get("hash")?.jsonPrimitive?.content
            when {
                seq == null || hash == null -> record(hubId, Status.Refused("invalid_input", "unreadable crate answer"))
                // A valid chain of ANOTHER hub, served for this one, is refused.
                hub != hubId -> record(hubId, Status.Refused("chain_hub_mismatch", "the served chain is hub $hub's"))
                else -> {
                    setAnchor(hubId, seq, hash)
                    record(hubId, Status.Verified(seq, hash, verified["alerts"]?.jsonArray?.size ?: 0))
                }
            }
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
        if (status == null || status == Status.None) status = load(hubId)
        if (status !is Status.Verified) throw SealingStoppedException(hubId)
    }

    // ── Founding (new-hub genesis, §5.6) ──

    private suspend fun ownHead(user: String): JsonObject {
        val links = apiService.getSigchain(user).links
        val request = buildJsonObject { put("op", "verifySigchain"); put("links", cryptoSigchainLinks(links)) }
        val state = json.parseToJsonElement(cryptoService.hubChainCall(request.toString())).jsonObject
        val device = cryptoService.signingPubkeyHex ?: error("Device is locked")
        val active = state["activeDevicePubkeys"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
        check(device in active) { "This device is not active in its user chain" }
        return buildJsonObject {
            put("seq", state.getValue("headSeq").jsonPrimitive.int)
            put("hash", state.getValue("headHash").jsonPrimitive.content)
        }
    }

    private suspend fun sign(unsigned: JsonObject): JsonObject =
        json.parseToJsonElement(cryptoService.signHubLink(unsigned.toString())).jsonObject

    /**
     * Found a hub: this device signs its genesis (the founder alone, holding the
     * founder bundles the server's catalog names), the server stores it as the
     * chain's first link, then each bundle's permissions are committed in a
     * `policy {kind: bundle}` link.
     */
    suspend fun foundHub(fields: JsonObject) {
        val founder = cryptoService.signingPubkeyHex ?: error("Device is locked")
        val founding = apiService.request<JsonObject>("GET", "/api/hubs/founding")
        val bundles = founding.getValue("bundles").jsonArray.map { it.jsonObject }
        val head = ownHead(founder)
        val hubId = java.util.UUID.randomUUID().toString().lowercase()
        val genesis = sign(buildJsonObject {
            put("hub", hubId)
            put("seq", 1)
            put("prevHash", JsonNull)
            put("signerUser", founder)
            put("signerUserHead", head)
            put("body", buildJsonObject {
                put("type", "genesis")
                put("founder", founder)
                put("migration", 0)
                put("members", buildJsonArray {
                    add(buildJsonObject {
                        put("user", founder)
                        put("bundles", JsonArray(bundles.map { it.getValue("bundle").jsonPrimitive.content }.sorted().map(::JsonPrimitive)))
                    })
                })
            })
        })
        val body = JsonObject(fields + mapOf("id" to JsonPrimitive(hubId), "genesis" to genesis))
        apiService.request<JsonObject>("POST", "/api/hubs", body)
        setAnchor(hubId, 1, genesis.getValue("entryHash").jsonPrimitive.content)

        var prev = genesis
        for (b in bundles) {
            val permissions = b.getValue("permissions").jsonArray
            val hashAnswer = cryptoService.hubChainCall(buildJsonObject { put("op", "permsHash"); put("permissions", permissions) }.toString())
            val permsHash = json.parseToJsonElement(hashAnswer).jsonObject.getValue("permsHash").jsonPrimitive.content
            val link = sign(buildJsonObject {
                put("hub", hubId)
                put("seq", prev.getValue("seq").jsonPrimitive.int + 1)
                put("prevHash", prev.getValue("entryHash"))
                put("signerUser", founder)
                put("signerUserHead", head)
                put("body", buildJsonObject {
                    put("type", "policy")
                    put("kind", "bundle")
                    put("bundle", b.getValue("bundle"))
                    put("permissions", permissions)
                    put("permsHash", permsHash)
                })
            })
            apiService.request<JsonObject>("POST", apiService.hubPath(hubId, "/api/chain"), buildJsonObject { put("link", link) })
            setAnchor(hubId, link.getValue("seq").jsonPrimitive.int, link.getValue("entryHash").jsonPrimitive.content)
            prev = link
        }
    }

    companion object {
        private const val KEY_ANCHORS = "hub-chain-anchors"

        /** The crate's closed rejection code of an error (`chain_fork`, …). */
        fun rejectionCode(e: Throwable): String {
            val message = (e.cause?.message ?: "") + " " + (e.message ?: "")
            return Regex("""(?:hub chain|sigchain) rejected \(([a-z_]+)\)""").find(message)?.groupValues?.get(1)
                ?: "invalid_input"
        }
    }
}

/** The server's user-chain links in the crate's `SigchainLink` JSON shape. */
fun cryptoSigchainLinks(links: List<SigchainResponseLink>): JsonArray = buildJsonArray {
    for (l in links) {
        add(
            buildJsonObject {
                put("id", l.id)
                put("seq", l.seqNo)
                put("prevHash", l.prevHash?.takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) } ?: JsonNull)
                put("entryHash", l.hash)
                put("signerDeviceId", l.signerDeviceID)
                put("signerPubkey", l.signerPubkey)
                put("signature", l.signature)
                put("timestamp", l.timestamp)
                put("payloadJson", (l.payload ?: JsonNull).toString())
            },
        )
    }
}
