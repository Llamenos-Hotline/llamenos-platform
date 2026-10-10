package org.llamenos.hotline.api

import androidx.annotation.VisibleForTesting
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.HubActivityService
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.protocol.CryptoLabels
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * WebSocket client for the Llamenos relay protocol
 * (`packages/protocol/schemas/ws-messages.ts`):
 *
 *   connect → `{type:"challenge"}` → Ed25519 `{type:"auth"}`
 *           → `{type:"authenticated", hubs}` → `{type:"subscribe", hubId, kinds}`
 *             per member hub → `{type:"event", hubId, kind, payload, epoch, ts, sig}`
 *
 * The endpoint is the one the server advertises as `wsRelayUrl` in
 * `GET /api/config` (currently `/ws`), resolved against the configured hub URL.
 *
 * Multi-hub routing axiom: every hub the server lists in `authenticated` is
 * subscribed, and each event is attributed by the `hubId` in its envelope —
 * the active hub is never consulted for routing, and no event is dropped or
 * relabelled because of it.
 *
 * Implements automatic reconnection with exponential backoff.
 */
@Singleton
class WebSocketService @Inject constructor(
    private val cryptoService: CryptoService,
    private val keystoreService: KeyValueStore,
    private val hubActivityService: HubActivityService,
    private val apiService: ApiService,
) {

    enum class ConnectionState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        RECONNECTING,
    }

    companion object {
        /**
         * Relay event kinds subscribed on every member hub: call ring/update/voicemail,
         * new message, conversation assigned, presence. Mirrors desktop and iOS.
         */
        val RELAY_EVENT_KINDS = listOf(1000, 1001, 1002, 1010, 1011, 20000)

        /**
         * Defensive filter for the server's pseudo-hub. The current server never
         * lists one (`lookupUserHubs` returns real memberships only), but iOS guards
         * the same way so all mobile clients behave identically if one appears.
         */
        const val GLOBAL_PSEUDO_HUB_ID = "global"

        /**
         * Map the server-advertised relay endpoint (`wsRelayUrl`, e.g. `/ws`) onto a
         * WebSocket URL against the configured hub URL.
         *
         * TLS is mandatory: `https` maps to `wss`. Cleartext `http`/`ws` resolves
         * only in debug builds (local development and CI emulators) — in release
         * builds a cleartext relay would expose all communications (H33), so the
         * result is null and no connection is attempted.
         */
        @VisibleForTesting
        internal fun relayWebSocketUrl(hubUrl: String, advertised: String?, isDebug: Boolean): String? {
            val trimmed = advertised?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val base = hubUrl.trimEnd('/')
            val resolved = if (trimmed.startsWith("/")) base + trimmed else trimmed
            return when {
                resolved.startsWith("https://") -> "wss://" + resolved.removePrefix("https://")
                resolved.startsWith("wss://") -> resolved
                (resolved.startsWith("http://") || resolved.startsWith("ws://")) && isDebug ->
                    "ws://" + resolved.removePrefix("http://").removePrefix("ws://")
                else -> null
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0

    @Volatile
    private var authenticated = false

    @Volatile
    private var intentionalDisconnect = false

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _typedEvents = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>(extraBufferCapacity = 64)

    /**
     * Typed application events parsed from relay messages.
     *
     * Each event is wrapped in [AttributedHubEvent] carrying the `hubId` from the
     * server envelope — the authoritative origin of the event, independent of which
     * hub is active in the UI. Subscribers must not discard events from non-active
     * hubs; the active hub controls browsing context only.
     */
    val typedEvents: SharedFlow<AttributedHubEvent<LlamenosEvent>> = _typedEvents.asSharedFlow()

    /**
     * Store server event keys in Rust memory after authentication.
     * Keys never touch JVM memory.
     */
    fun setServerEventKeys(currentHex: String, previousHex: String = "") {
        cryptoService.setServerEventKeys(currentHex, previousHex)
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS) // No read timeout for WebSocket
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    /**
     * Connect to the relay endpoint advertised by the server.
     * Authenticates via the challenge-response handshake, then subscribes to
     * every hub the server reports this device user as a member of.
     */
    fun connect() {
        if (_connectionState.value == ConnectionState.CONNECTED ||
            _connectionState.value == ConnectionState.CONNECTING
        ) {
            return
        }

        scope.launch {
            intentionalDisconnect = false
            val relayUrl = resolveRelayUrl()
            if (relayUrl == null) {
                _connectionState.value = ConnectionState.DISCONNECTED
                scheduleReconnect()
                return@launch
            }
            openSocket(relayUrl)
        }
    }

    /**
     * Resolve the relay WebSocket URL from the server-advertised `wsRelayUrl`
     * (`GET /api/config`) against the configured hub URL. Returns null when the
     * server advertises no relay, the config fetch fails, or the endpoint fails
     * the TLS transport rule — the caller then retries via reconnect backoff.
     */
    internal suspend fun resolveRelayUrl(): String? {
        val hubUrl = keystoreService.retrieve(KeystoreService.KEY_HUB_URL) ?: return null
        val advertised = try {
            apiService.request<AppConfigResponse>("GET", "/api/config").wsRelayUrl
        } catch (e: Exception) {
            android.util.Log.w("WebSocketService", "Relay config fetch failed: ${e.message}")
            null
        }
        val url = relayWebSocketUrl(hubUrl, advertised, org.llamenos.hotline.BuildConfig.DEBUG)
        if (url == null && advertised != null) {
            android.util.Log.e("WebSocketService", "Refusing relay connection: endpoint is not TLS-protected")
        }
        return url
    }

    private fun openSocket(relayUrl: String) {
        _connectionState.value = ConnectionState.CONNECTING
        authenticated = false

        // Apply the same app-level certificate pinning as ApiService for the relay
        // host, so operator-customised deployments are pinned on the WS leg too.
        // Loopback stays unpinned for local development.
        val host = runCatching { java.net.URI(relayUrl).host }.getOrNull()
        val wsClient = if (host == null || host == "localhost" || host == "127.0.0.1") {
            client
        } else {
            client.newBuilder().certificatePinner(ApiService.buildPinner(host)).build()
        }

        val request = Request.Builder()
            .url(relayUrl)
            .build()

        webSocket = wsClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempt = 0
                // Stay CONNECTING until the auth handshake completes — CONNECTED
                // means the relay is usable (authenticated + subscribed).
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleServerMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                authenticated = false
                _connectionState.value = ConnectionState.DISCONNECTED
                // Server-initiated closes (e.g. 4001 auth timeout) must reconnect —
                // only an explicit disconnect() stays down.
                if (!intentionalDisconnect) scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                authenticated = false
                _connectionState.value = ConnectionState.DISCONNECTED
                scheduleReconnect()
            }
        })
    }

    /**
     * Disconnect from the relay and cancel any pending reconnection.
     */
    fun disconnect() {
        intentionalDisconnect = true
        scope.launch {
            reconnectJob?.cancelAndJoin()
            reconnectJob = null
        }
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        authenticated = false
        _connectionState.value = ConnectionState.DISCONNECTED
        reconnectAttempt = 0
    }

    @VisibleForTesting
    internal fun handleServerMessage(text: String) {
        val obj = try {
            json.parseToJsonElement(text).jsonObject
        } catch (_: Exception) {
            return
        }
        when (obj["type"]?.jsonPrimitive?.content) {
            "challenge" -> {
                val nonce = obj["nonce"]?.jsonPrimitive?.content ?: return
                handleChallenge(nonce)
            }
            "authenticated" -> {
                val hubs = obj["hubs"]?.jsonArray?.mapNotNull {
                    runCatching { it.jsonPrimitive.content }.getOrNull()
                } ?: emptyList()
                handleAuthenticated(hubs)
            }
            "event" -> handleEventMessage(obj)
            "subscribed", "unsubscribed", "pong" -> {
                // Confirmations and keepalives need no action.
            }
            "error" -> {
                val code = obj["code"]?.jsonPrimitive?.content
                if (code == "auth_failed") {
                    authenticated = false
                    android.util.Log.e("WebSocketService", "Relay auth failed: ${obj["message"]?.jsonPrimitive?.content}")
                }
            }
        }
    }

    /**
     * Answer the server's auth challenge: sign
     * `LABEL_WS_CHALLENGE:{pubkey}:{nonce}:{ts}` with the device Ed25519 key
     * (via Rust — the private key never crosses JNI) and send `{type:"auth"}`.
     */
    private fun handleChallenge(nonce: String) {
        val pubkey = cryptoService.signingPubkeyHex ?: return
        val ts = System.currentTimeMillis()
        val signedMessage = "${CryptoLabels.LABEL_WS_CHALLENGE}:$pubkey:$nonce:$ts"
        val messageHex = signedMessage.toByteArray(Charsets.UTF_8)
            .joinToString("") { "%02x".format(it) }
        val sig = cryptoService.ed25519Sign(messageHex) ?: return

        val authMessage = buildJsonObject {
            put("type", "auth")
            put("pubkey", pubkey)
            put("nonce", nonce)
            put("ts", ts)
            put("sig", sig)
        }
        webSocket?.send(authMessage.toString())
    }

    /**
     * Auth succeeded: subscribe to every member hub from the server's
     * authoritative list, never only the active hub (multi-hub routing axiom).
     */
    private fun handleAuthenticated(hubs: List<String>) {
        authenticated = true
        _connectionState.value = ConnectionState.CONNECTED
        for (hubId in hubs) {
            if (hubId == GLOBAL_PSEUDO_HUB_ID) continue
            sendSubscribe(hubId, RELAY_EVENT_KINDS)
        }
    }

    private fun sendSubscribe(hubId: String, kinds: List<Int>) {
        val message = buildJsonObject {
            put("type", "subscribe")
            put("hubId", hubId)
            putJsonArray("kinds") { kinds.forEach { add(it) } }
        }
        webSocket?.send(message.toString())
    }

    /**
     * Handle a relay event envelope. The envelope's `hubId` is the source of
     * truth for attribution — the payload is encrypted with the server event
     * key (not a per-hub key), so key-trial attribution cannot work here and
     * the active hub is never used as a fallback.
     */
    private fun handleEventMessage(obj: kotlinx.serialization.json.JsonObject) {
        val hubId = obj["hubId"]?.jsonPrimitive?.content ?: return
        val payload = obj["payload"]?.jsonPrimitive?.content ?: return
        obj["epoch"]?.jsonPrimitive?.intOrNull ?: return

        val plaintext = cryptoService.decryptServerEventWithStoredKeys(payload) ?: return
        val event = parseTypedEvent(plaintext) ?: return
        val attributed = AttributedHubEvent(hubId = hubId, event = event)

        // In-memory per-hub activity tracking is cheap and synchronous so tests
        // and badges see it immediately; flow emission is async for subscribers.
        hubActivityService.handle(attributed)
        scope.launch {
            _typedEvents.emit(attributed)
        }
    }

    /**
     * Parse the decrypted event content JSON into a typed [LlamenosEvent].
     * Returns null for unparseable content (graceful forward compatibility).
     */
    private fun parseTypedEvent(content: String): LlamenosEvent? {
        return try {
            val obj = json.parseToJsonElement(content).jsonObject
            val type = obj["type"]?.jsonPrimitive?.content ?: return null

            when (type) {
                "call:ring" -> LlamenosEvent.CallRing(
                    obj["callId"]?.jsonPrimitive?.content ?: return null
                )
                "call:update" -> {
                    val callId = obj["callId"]?.jsonPrimitive?.content ?: return null
                    val status = obj["status"]?.jsonPrimitive?.content ?: return null
                    if (status == "completed") LlamenosEvent.CallEnded(callId)
                    else LlamenosEvent.CallUpdate(callId, status)
                }
                "voicemail:new" -> LlamenosEvent.VoicemailNew(
                    obj["callId"]?.jsonPrimitive?.content ?: return null
                )
                "presence:summary" -> LlamenosEvent.PresenceSummary(
                    obj["hasAvailable"]?.jsonPrimitive?.content?.toBoolean() ?: false
                )
                "message:new" -> LlamenosEvent.MessageNew(
                    obj["conversationId"]?.jsonPrimitive?.content ?: return null
                )
                "conversation:assigned" -> LlamenosEvent.ConversationAssigned(
                    obj["conversationId"]?.jsonPrimitive?.content ?: return null,
                    obj["assignedTo"]?.jsonPrimitive?.content
                )
                "conversation:closed" -> LlamenosEvent.ConversationClosed(
                    obj["conversationId"]?.jsonPrimitive?.content ?: return null
                )
                "device:wipe" -> LlamenosEvent.DeviceWipe(
                    targetDevicePubkey = obj["targetDevicePubkey"]?.jsonPrimitive?.content ?: "",
                    reason = obj["reason"]?.jsonPrimitive?.content ?: "",
                    serverSignature = obj["serverSignature"]?.jsonPrimitive?.content ?: "",
                )
                else -> LlamenosEvent.Unknown(type)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            _connectionState.value = ConnectionState.RECONNECTING
            reconnectAttempt++

            // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
            val delayMs = minOf(1000L * (1L shl minOf(reconnectAttempt - 1, 4)), 30_000L)
            delay(delayMs)

            connect()
        }
    }
}
