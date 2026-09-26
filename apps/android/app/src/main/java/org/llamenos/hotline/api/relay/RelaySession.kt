package org.llamenos.hotline.api.relay

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.protocol.CryptoLabels
import org.llamenos.protocol.WsAuthMessage
import org.llamenos.protocol.WsAuthMessageType
import org.llamenos.protocol.WsAuthenticatedMessage
import org.llamenos.protocol.WsChallengeMessage
import org.llamenos.protocol.WsErrorMessage
import org.llamenos.protocol.WsEventMessage
import org.llamenos.protocol.WsReplayMessage
import org.llamenos.protocol.WsReplayMessageType
import org.llamenos.protocol.WsSubscribeMessage
import org.llamenos.protocol.WsSubscribeMessageType

/**
 * Event kinds the Android client subscribes to on every member hub.
 *
 * Mirrors the kind numbers in `packages/shared/event-kinds.ts` for the event types that
 * [RelayEventParser] understands. Kind numbers are not part of the protocol codegen yet.
 */
object RelayEventKinds {
    const val CALL_RING = 1000L
    const val CALL_UPDATE = 1001L
    const val CALL_VOICEMAIL = 1002L
    const val MESSAGE_NEW = 1010L
    const val CONVERSATION_ASSIGNED = 1011L
    const val PRESENCE_UPDATE = 20000L

    val SUBSCRIBED: List<Long> = listOf(
        CALL_RING, CALL_UPDATE, CALL_VOICEMAIL, MESSAGE_NEW, CONVERSATION_ASSIGNED, PRESENCE_UPDATE,
    )
}

/**
 * Drops relay events that were already delivered — the server replays its ring buffer
 * after a reconnect, so the same signed event can arrive twice. Events older than
 * [maxAgeMs] are treated as stale and dropped too (same window as the desktop client).
 *
 * Shared across [RelaySession]s so deduplication survives a reconnect.
 */
class RelayEventDeduplicator(
    private val maxAgeMs: Long = 5 * 60 * 1000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val seen = LinkedHashMap<String, Long>()

    /** Returns true if the event is fresh and has not been seen before. */
    @Synchronized
    fun isNew(key: String, eventTsMs: Long): Boolean {
        val now = clock()
        if (now - eventTsMs > maxAgeMs) return false
        val iterator = seen.entries.iterator()
        while (iterator.hasNext()) {
            if (now - iterator.next().value > maxAgeMs) iterator.remove() else break
        }
        if (seen.containsKey(key)) return false
        seen[key] = eventTsMs
        return true
    }
}

/**
 * One authenticated relay session: the server protocol from
 * `packages/protocol/schemas/ws-messages.ts`, with no transport attached.
 *
 * ```
 * server → {type:'challenge', nonce}
 * client → {type:'auth', pubkey, nonce, ts, sig}      sig = Ed25519(LABEL_WS_CHALLENGE:pubkey:nonce:ts)
 * server → {type:'authenticated', hubs}
 * client → {type:'subscribe', hubId, kinds}           for EVERY hub the server lists
 * server → {type:'event', v, hubId, kind, payload, epoch, ts, sig}
 * ```
 *
 * Every message is (de)serialized through the generated protocol types. An event is
 * delivered only after its server signature verifies, and it is attributed to the hub
 * named in its signed envelope — never to whichever hub is active in the UI.
 *
 * @param replaySinceMs on a reconnect, the epoch millisecond to replay missed events from
 *   (the server compares `since` against event timestamps in ms and clamps it to 5 min)
 * @param ensureEventKeys called before decrypting an event so the caller can fetch server
 *   event keys for an epoch it does not hold yet (the key rotates every UTC day)
 */
class RelaySession(
    private val crypto: RelayCrypto,
    private val serverPubkeyHex: String,
    private val deduplicator: RelayEventDeduplicator,
    private val replaySinceMs: Long? = null,
    private val kinds: List<Long> = RelayEventKinds.SUBSCRIBED,
    private val ensureEventKeys: suspend (epoch: Long) -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
) {

    sealed interface Action {
        /** Send this text frame to the server. */
        data class Send(val frame: String) : Action

        /** The server accepted our auth; [hubs] are the hubs we are now subscribing to. */
        data class Authenticated(val hubs: List<String>) : Action

        /** A verified, decrypted event, attributed to the hub in its envelope. */
        data class Deliver(val event: AttributedHubEvent<LlamenosEvent>) : Action

        /** Authentication cannot proceed — the caller must close the connection. */
        data class AuthFailed(val reason: String) : Action

        /** A non-fatal server error (e.g. `not_member`, `rate_limited`). */
        data class ServerError(val code: String, val message: String) : Action
    }

    var isAuthenticated: Boolean = false
        private set

    /** Handle one text frame from the server and return what the caller must do. */
    suspend fun onFrame(text: String): List<Action> {
        val obj = try {
            json.parseToJsonElement(text).jsonObject
        } catch (_: IllegalArgumentException) {
            return emptyList()
        }
        return try {
            when (obj["type"]?.jsonPrimitive?.content) {
                "challenge" -> onChallenge(decode(obj, WsChallengeMessage.serializer()))
                "authenticated" -> onAuthenticated(decode(obj, WsAuthenticatedMessage.serializer()))
                "event" -> onEvent(decode(obj, WsEventMessage.serializer()))
                "error" -> onError(decode(obj, WsErrorMessage.serializer()))
                // subscribed / unsubscribed / pong need no action; anything else is not
                // part of the protocol this client speaks.
                else -> emptyList()
            }
        } catch (_: SerializationException) {
            emptyList()
        } catch (_: IllegalArgumentException) {
            emptyList()
        }
    }

    private fun onChallenge(msg: WsChallengeMessage): List<Action> {
        val pubkey = crypto.relayDevicePubkeyHex
            ?: return listOf(Action.AuthFailed("no device identity loaded"))
        val ts = clock()
        val signed = "${CryptoLabels.LABEL_WS_CHALLENGE}:$pubkey:${msg.nonce}:$ts"
        val sig = try {
            crypto.signRelayChallenge(signed.toByteArray(Charsets.UTF_8).toHex())
        } catch (e: IllegalStateException) {
            return listOf(Action.AuthFailed("cannot sign challenge: ${e.message}"))
        }
        val auth = WsAuthMessage(
            nonce = msg.nonce,
            pubkey = pubkey,
            sig = sig,
            ts = ts.toDouble(),
            type = WsAuthMessageType.Auth,
        )
        return listOf(Action.Send(json.encodeToString(WsAuthMessage.serializer(), auth)))
    }

    private fun onAuthenticated(msg: WsAuthenticatedMessage): List<Action> {
        isAuthenticated = true
        val actions = mutableListOf<Action>(Action.Authenticated(msg.hubs))
        val kindValues = kinds.map { it.toDouble() }
        for (hubId in msg.hubs) {
            val subscribe = WsSubscribeMessage(hubID = hubId, kinds = kindValues, type = WsSubscribeMessageType.Subscribe)
            actions += Action.Send(json.encodeToString(WsSubscribeMessage.serializer(), subscribe))
            if (replaySinceMs != null) {
                val replay = WsReplayMessage(hubID = hubId, since = replaySinceMs.toDouble(), type = WsReplayMessageType.Replay)
                actions += Action.Send(json.encodeToString(WsReplayMessage.serializer(), replay))
            }
        }
        return actions
    }

    private suspend fun onEvent(msg: WsEventMessage): List<Action> {
        if (!isAuthenticated) return emptyList()
        // The server signs `${v}:${hubId}:${kind}:${epoch}:${payload}:${ts}` with JavaScript
        // number formatting. All four numbers are integers on the wire.
        val v = msg.v.asWireInt() ?: return emptyList()
        val kind = msg.kind.asWireInt() ?: return emptyList()
        val epoch = msg.epoch.asWireInt() ?: return emptyList()
        val ts = msg.ts.asWireInt() ?: return emptyList()

        val signed = "$v:${msg.hubID}:$kind:$epoch:${msg.payload}:$ts"
        val valid = crypto.verifyServerEventSignature(
            signed.toByteArray(Charsets.UTF_8).toHex(),
            msg.sig,
            serverPubkeyHex,
        )
        if (!valid) return emptyList()

        if (!deduplicator.isNew(msg.sig, ts)) return emptyList()

        ensureEventKeys(epoch)
        val plaintext = crypto.decryptServerEventForEpoch(msg.payload, epoch) ?: return emptyList()
        val event = RelayEventParser.parse(plaintext) ?: return emptyList()
        return listOf(Action.Deliver(AttributedHubEvent(hubId = msg.hubID, event = event)))
    }

    private fun onError(msg: WsErrorMessage): List<Action> =
        if (msg.code == "auth_failed") {
            isAuthenticated = false
            listOf(Action.AuthFailed(msg.message))
        } else {
            listOf(Action.ServerError(msg.code, msg.message))
        }

    private fun <T> decode(obj: JsonObject, serializer: kotlinx.serialization.KSerializer<T>): T =
        json.decodeFromJsonElement(serializer, obj)

    private companion object {
        val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
            explicitNulls = false
        }

        /** Largest integer a JavaScript number represents exactly (2^53 - 1). */
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

        /** The value as a Long if it is an exact integer the server could have produced. */
        fun Double.asWireInt(): Long? =
            if (this % 1.0 == 0.0 && this >= 0.0 && this <= MAX_SAFE_INTEGER) toLong() else null

        fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
    }
}

/**
 * Parses decrypted relay event content (`{"type": "...", ...}`) into a [LlamenosEvent].
 * Unrecognized types become [LlamenosEvent.Unknown] for forward compatibility; content
 * missing a required field yields null.
 */
object RelayEventParser {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(content: String): LlamenosEvent? {
        val obj = try {
            json.parseToJsonElement(content).jsonObject
        } catch (_: IllegalArgumentException) {
            return null
        }
        fun str(key: String): String? =
            (obj[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content
        val type = str("type") ?: return null

        return when (type) {
            "call:ring" -> LlamenosEvent.CallRing(str("callId") ?: return null)
            "call:update" -> {
                val callId = str("callId") ?: return null
                val status = str("status") ?: return null
                if (status == "completed") LlamenosEvent.CallEnded(callId) else LlamenosEvent.CallUpdate(callId, status)
            }
            "voicemail:new" -> LlamenosEvent.VoicemailNew(str("callId") ?: return null)
            "presence:summary" -> LlamenosEvent.PresenceSummary(str("hasAvailable")?.toBoolean() ?: false)
            "message:new" -> LlamenosEvent.MessageNew(str("conversationId") ?: return null)
            "conversation:assigned" -> LlamenosEvent.ConversationAssigned(
                str("conversationId") ?: return null,
                str("assignedTo"),
            )
            "conversation:closed" -> LlamenosEvent.ConversationClosed(str("conversationId") ?: return null)
            "device:wipe" -> LlamenosEvent.DeviceWipe(
                targetDevicePubkey = str("targetDevicePubkey") ?: "",
                reason = str("reason") ?: "",
                serverSignature = str("serverSignature") ?: "",
            )
            else -> LlamenosEvent.Unknown(type)
        }
    }
}
