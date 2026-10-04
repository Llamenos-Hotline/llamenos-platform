package org.llamenos.hotline.api

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.llamenos.hotline.BuildConfig
import org.llamenos.hotline.RelayUrlValidator
import org.llamenos.hotline.api.relay.RelayEventDeduplicator
import org.llamenos.hotline.api.relay.RelaySession
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.HubActivityService
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.model.MeResponse
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.protocol.ConfigResponse
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Foreground connection to the server's authenticated WebSocket relay.
 *
 * Connects to the relay the server advertises in `GET /api/config` (`wsRelayUrl`, i.e.
 * `/ws`), answers the Ed25519 challenge with the device key, and subscribes to every hub
 * the server reports this user as a member of. The wire protocol lives in [RelaySession].
 *
 * Events are delivered for ALL member hubs, each attributed to the hub named in its
 * server-signed envelope. The active hub is browsing context only: nothing here reads or
 * changes it (multi-hub routing axiom, CLAUDE.md).
 *
 * Reconnects with exponential backoff and asks the server to replay what it missed.
 */
@Singleton
class WebSocketService @Inject constructor(
    private val cryptoService: CryptoService,
    private val apiService: ApiService,
    private val hubActivityService: HubActivityService,
) {

    enum class ConnectionState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        RECONNECTING,
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)

    /** [ConnectionState.CONNECTED] only once the server has accepted our authentication. */
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _typedEvents = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>(extraBufferCapacity = 64)

    /**
     * Verified, decrypted relay events from every member hub.
     *
     * [AttributedHubEvent.hubId] is the hub the server published the event to, taken from
     * the signed envelope. Subscribers must handle events from every hub — never drop or
     * relabel one because it does not match the active hub.
     */
    val typedEvents: SharedFlow<AttributedHubEvent<LlamenosEvent>> = _typedEvents.asSharedFlow()

    private val deduplicator = RelayEventDeduplicator()
    private val eventKeyMutex = Mutex()

    @Volatile private var eventKeyEpoch: Long? = null
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var wantConnected = false
    @Volatile private var disconnectedAtMs: Long? = null
    private var connectJob: Job? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0

    /**
     * Open the relay connection if it is not already open or opening.
     * Safe to call repeatedly.
     */
    @Synchronized
    fun connect() {
        val state = _connectionState.value
        if (state == ConnectionState.CONNECTED || state == ConnectionState.CONNECTING) return
        wantConnected = true
        reconnectJob?.cancel()
        reconnectJob = null
        _connectionState.value = ConnectionState.CONNECTING
        connectJob = scope.launch { openSocket() }
    }

    /** Close the relay connection and cancel any pending reconnection. */
    @Synchronized
    fun disconnect() {
        wantConnected = false
        connectJob?.cancel()
        connectJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(NORMAL_CLOSURE, "Client disconnect")
        webSocket = null
        disconnectedAtMs = null
        reconnectAttempt = 0
        eventKeyEpoch = null
        _connectionState.value = ConnectionState.DISCONNECTED
    }

    private suspend fun openSocket() {
        val endpoint = try {
            resolveEndpoint()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Relay endpoint lookup failed: ${e.message}")
            onConnectionLost(null)
            return
        }
        if (endpoint == null) {
            // The server has no relay (no SERVER_SECRET) or the hub URL is not allowed.
            // Nothing to retry until the configuration changes.
            _connectionState.value = ConnectionState.DISCONNECTED
            return
        }

        refreshEventKeys()

        val session = RelaySession(
            crypto = cryptoService,
            serverPubkeyHex = endpoint.serverPubkeyHex,
            deduplicator = deduplicator,
            replaySinceMs = disconnectedAtMs,
            ensureEventKeys = ::ensureEventKeys,
        )
        val frames = Channel<String>(Channel.UNLIMITED)
        val request = Request.Builder().url(endpoint.url).build()
        val ws = apiService.relayHttpClient().newWebSocket(request, Listener(frames))
        synchronized(this) {
            if (!wantConnected) {
                ws.close(NORMAL_CLOSURE, "Client disconnect")
                return
            }
            webSocket = ws
        }

        // Frames are processed strictly in arrival order on one coroutine.
        for (frame in frames) {
            for (action in session.onFrame(frame)) {
                when (action) {
                    is RelaySession.Action.Send -> ws.send(action.frame)
                    is RelaySession.Action.Authenticated -> {
                        synchronized(this) { reconnectAttempt = 0 }
                        disconnectedAtMs = null
                        _connectionState.value = ConnectionState.CONNECTED
                    }
                    is RelaySession.Action.Deliver -> {
                        hubActivityService.handle(action.event)
                        _typedEvents.emit(action.event)
                    }
                    is RelaySession.Action.AuthFailed -> {
                        Log.w(TAG, "Relay authentication failed: ${action.reason}")
                        ws.close(NORMAL_CLOSURE, "Authentication failed")
                    }
                    is RelaySession.Action.ServerError ->
                        Log.w(TAG, "Relay error ${action.code}: ${action.message}")
                }
            }
        }
        onConnectionLost(ws, wasAuthenticated = session.isAuthenticated)
    }

    private inner class Listener(private val frames: Channel<String>) : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            frames.trySend(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(NORMAL_CLOSURE, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            frames.close()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "Relay connection failed: ${t.message}")
            frames.close()
        }
    }

    @Synchronized
    private fun onConnectionLost(ws: WebSocket?, wasAuthenticated: Boolean = false) {
        // A socket we already replaced or deliberately closed is not a lost connection.
        if (ws != null && webSocket !== ws) return
        webSocket = null
        if (wasAuthenticated) disconnectedAtMs = System.currentTimeMillis()
        if (!wantConnected) {
            _connectionState.value = ConnectionState.DISCONNECTED
            return
        }
        _connectionState.value = ConnectionState.RECONNECTING
        reconnectAttempt++
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, then 30s.
        val delayMs = minOf(1000L * (1L shl minOf(reconnectAttempt - 1, 5)), MAX_RECONNECT_DELAY_MS)
        reconnectJob = scope.launch {
            delay(delayMs)
            synchronized(this@WebSocketService) {
                if (!wantConnected) return@launch
                _connectionState.value = ConnectionState.CONNECTING
                connectJob = scope.launch { openSocket() }
            }
        }
    }

    private data class RelayEndpoint(val url: String, val serverPubkeyHex: String)

    /**
     * Read the relay path and server signing pubkey from `GET /api/config`.
     * Returns null when the server advertises no relay.
     */
    private suspend fun resolveEndpoint(): RelayEndpoint? {
        val config = apiService.request<ConfigResponse>("GET", "/api/config")
        val serverPubkey = config.serverPubkey ?: return null
        val relayPath = config.wsRelayURL ?: return null
        val url = relayUrl(apiService.hubBaseUrl(), relayPath, allowCleartext = BuildConfig.DEBUG)
        if (url == null) {
            Log.e(TAG, "Refusing relay connection: relay URL is not an encrypted URL on the hub server")
            return null
        }
        return RelayEndpoint(url, serverPubkey)
    }

    /**
     * Fetch the server event keys (current + previous epoch) from `GET /api/auth/me` into
     * Rust memory. On failure events stay undecryptable until the next attempt.
     */
    private suspend fun refreshEventKeys() {
        eventKeyMutex.withLock { loadEventKeys() }
    }

    /** Refetch the event keys if [epoch] is newer than the keys we hold (daily rotation). */
    private suspend fun ensureEventKeys(epoch: Long) {
        if ((eventKeyEpoch ?: -1L) >= epoch) return
        eventKeyMutex.withLock {
            if ((eventKeyEpoch ?: -1L) < epoch) loadEventKeys()
        }
    }

    private suspend fun loadEventKeys() {
        try {
            val me = apiService.request<MeResponse>("GET", "/api/auth/me")
            val current = me.serverEventKeyHex ?: return
            cryptoService.setServerEventKeys(current, me.serverEventKeyPrevHex)
            eventKeyEpoch = me.eventKeyEpoch?.toLong()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Could not load server event keys: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "WebSocketService"
        private const val NORMAL_CLOSURE = 1000
        private const val MAX_RECONNECT_DELAY_MS = 30_000L

        /**
         * Resolve the server-advertised relay location against the configured hub URL.
         *
         * A relative path (the server sends `/ws`) is joined to the hub URL with `https` →
         * `wss`; `http` → `ws` only when [allowCleartext] (debug builds, for local
         * development). An absolute URL must be `wss` on the hub's own host (H33).
         * Returns null for anything else.
         */
        internal fun relayUrl(hubBaseUrl: String, relayPath: String, allowCleartext: Boolean): String? {
            val base = hubBaseUrl.trimEnd('/')
            if (!relayPath.startsWith("/")) {
                return relayPath.takeIf {
                    it.startsWith("wss://") && RelayUrlValidator.isValidRelayUrl(it, base)
                }
            }
            return when {
                base.startsWith("https://") -> "wss://" + base.removePrefix("https://") + relayPath
                base.startsWith("http://") && allowCleartext -> "ws://" + base.removePrefix("http://") + relayPath
                else -> null
            }
        }
    }
}
