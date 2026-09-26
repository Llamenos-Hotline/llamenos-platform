package org.llamenos.hotline.service

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.NetworkMonitor
import org.llamenos.hotline.crypto.KeyValueStore
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

/**
 * Types of write operations that can be queued for offline replay.
 */
@Serializable
enum class QueuedOperationType {
    NOTE_CREATE,
    NOTE_UPDATE,
    MESSAGE_SEND,
    SHIFT_TOGGLE,
    REPORT_CREATE,
    REPORT_MESSAGE,
    BAN_ADD,
    BAN_REMOVE,
    GENERIC_WRITE,
}

/**
 * A write operation persisted for later replay when the network is available.
 */
@Serializable
data class QueuedOperation(
    val id: String,
    val type: QueuedOperationType,
    /** API path (e.g., "/api/notes") */
    val path: String,
    /** HTTP method (POST, PUT, PATCH, DELETE) */
    val method: String,
    /** JSON-serialized request body, or null for bodyless requests */
    val body: String?,
    /** ISO 8601 timestamp when the operation was queued */
    val queuedAt: String,
    /** Number of replay attempts so far */
    var attempts: Int = 0,
    /** Last error message from a failed replay attempt */
    var lastError: String? = null,
)

/**
 * Persists write operations when the network is unavailable and replays them
 * in FIFO order on reconnect with exponential backoff.
 *
 * Operations are stored in [KeyValueStore] (EncryptedSharedPreferences) so they
 * are encrypted at rest. The queue observes [NetworkMonitor] for connectivity
 * changes and triggers automatic replay on reconnect.
 *
 * Injected as a singleton via Hilt. UI observes [pendingCount] to show the
 * offline banner with pending operation count.
 */
@Singleton
class OfflineQueue @Inject constructor(
    private val keystoreService: KeyValueStore,
    private val networkMonitor: NetworkMonitor,
) {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var queue: MutableList<QueuedOperation> = mutableListOf()

    private val _pendingCount = MutableStateFlow(0)

    /** Number of operations waiting to be replayed. Observable by UI. */
    val pendingCount: StateFlow<Int> = _pendingCount.asStateFlow()

    private val _isReplaying = MutableStateFlow(false)

    /** Whether the queue is currently replaying operations. */
    val isReplaying: StateFlow<Boolean> = _isReplaying.asStateFlow()

    /**
     * Late-initialized reference to ApiService. Set by AppModule or MainScreen
     * after Hilt wires everything. Avoids circular dependency (ApiService -> OfflineQueue -> ApiService).
     */
    var apiService: ApiService? = null

    init {
        loadFromDisk()
        _pendingCount.value = queue.size
    }

    /**
     * Start observing network connectivity. When connectivity is restored
     * and the queue is non-empty, replay is triggered automatically.
     */
    fun startMonitoring() {
        scope.launch {
            var wasOnline = networkMonitor.isOnline.value
            networkMonitor.isOnline.collect { isOnline ->
                if (isOnline && !wasOnline && queue.isNotEmpty()) {
                    replay()
                }
                wasOnline = isOnline
            }
        }
    }

    /**
     * Add a write operation to the queue for later replay.
     *
     * @param path API path (e.g., "/api/notes")
     * @param method HTTP method (POST, PUT, PATCH, DELETE)
     * @param body JSON-serialized request body, or null
     * @return The queued operation ID
     */
    fun enqueue(path: String, method: String, body: String?): String {
        val op = QueuedOperation(
            id = UUID.randomUUID().toString(),
            type = classifyOperation(path, method),
            path = path,
            method = method.uppercase(),
            body = body,
            queuedAt = java.time.Instant.now().toString(),
        )
        synchronized(queue) {
            queue.add(op)
            _pendingCount.value = queue.size
        }
        saveToDisk()
        return op.id
    }

    /**
     * Attempt to replay all queued operations in FIFO order.
     *
     * Operations are removed on success (HTTP 2xx or 409 conflict).
     * Permanent client errors (4xx except 401/429) increment the attempt counter;
     * the operation is removed after [MAX_ATTEMPTS].
     * Server errors (5xx) and network errors cause retry with exponential backoff.
     */
    suspend fun replay() {
        val api = apiService ?: return
        if (_isReplaying.value || queue.isEmpty()) return

        _isReplaying.value = true
        val toRemove = mutableSetOf<String>()

        val snapshot = synchronized(queue) { queue.toList() }

        for ((index, op) in snapshot.withIndex()) {
            if (!networkMonitor.isOnline.value) break

            try {
                api.requestRawNoContent(op.method, op.path, op.body)
                toRemove.add(op.id)
            } catch (e: ApiException) {
                val code = e.code
                if (code == 409) {
                    // Idempotent conflict — already applied
                    toRemove.add(op.id)
                } else if (code in 400..499 && code != 401 && code != 429) {
                    // Permanent client error
                    synchronized(queue) {
                        queue.getOrNull(index)?.let { mutableOp ->
                            mutableOp.attempts++
                            mutableOp.lastError = "HTTP $code"
                            if (mutableOp.attempts >= MAX_ATTEMPTS) {
                                toRemove.add(mutableOp.id)
                            }
                        }
                    }
                } else {
                    // Server error / auth / rate limit — retry with backoff
                    synchronized(queue) {
                        queue.getOrNull(index)?.let { mutableOp ->
                            mutableOp.attempts++
                            mutableOp.lastError = "HTTP $code"
                        }
                    }
                    val delayMs = min(
                        BASE_RETRY_DELAY_MS * 2.0.pow(op.attempts.toDouble()),
                        MAX_RETRY_DELAY_MS.toDouble(),
                    ).toLong()
                    delay(delayMs)
                }
            } catch (_: IOException) {
                // Network error — stop processing
                synchronized(queue) {
                    queue.getOrNull(index)?.let { mutableOp ->
                        mutableOp.attempts++
                        mutableOp.lastError = "Network error"
                    }
                }
                break
            } catch (_: Exception) {
                // Unexpected error — skip and continue
                synchronized(queue) {
                    queue.getOrNull(index)?.let { mutableOp ->
                        mutableOp.attempts++
                        mutableOp.lastError = "Unexpected error"
                    }
                }
            }
        }

        synchronized(queue) {
            queue.removeAll { it.id in toRemove }
            _pendingCount.value = queue.size
        }
        saveToDisk()
        _isReplaying.value = false
    }

    /**
     * Remove a single operation from the queue.
     */
    fun remove(id: String) {
        synchronized(queue) {
            queue.removeAll { it.id == id }
            _pendingCount.value = queue.size
        }
        saveToDisk()
    }

    /**
     * Clear all queued operations.
     */
    fun clear() {
        synchronized(queue) {
            queue.clear()
            _pendingCount.value = 0
        }
        saveToDisk()
    }

    /**
     * Current queue snapshot for UI display.
     */
    fun getQueue(): List<QueuedOperation> = synchronized(queue) { queue.toList() }

    // MARK: - Classification

    private fun classifyOperation(path: String, method: String): QueuedOperationType {
        val m = method.uppercase()
        return when {
            path.contains("/notes") && m == "POST" -> QueuedOperationType.NOTE_CREATE
            path.contains("/notes/") && m == "PATCH" -> QueuedOperationType.NOTE_UPDATE
            path.contains("/messages") && m == "POST" -> QueuedOperationType.MESSAGE_SEND
            path.contains("/shifts/my-status") || path.contains("/shifts/clock") -> QueuedOperationType.SHIFT_TOGGLE
            path.contains("/reports") && m == "POST" && !path.contains("/messages") -> QueuedOperationType.REPORT_CREATE
            path.contains("/reports/") && path.contains("/messages") && m == "POST" -> QueuedOperationType.REPORT_MESSAGE
            path.contains("/bans") && m == "POST" -> QueuedOperationType.BAN_ADD
            path.contains("/bans/") && m == "DELETE" -> QueuedOperationType.BAN_REMOVE
            else -> QueuedOperationType.GENERIC_WRITE
        }
    }

    // MARK: - Persistence

    private fun saveToDisk() {
        try {
            val data = synchronized(queue) { json.encodeToString(queue.toList()) }
            keystoreService.store(STORAGE_KEY, data)
        } catch (_: Exception) {
            // Persistence failure — operations may be lost on app termination
        }
    }

    private fun loadFromDisk() {
        try {
            val data = keystoreService.retrieve(STORAGE_KEY) ?: return
            queue = json.decodeFromString<List<QueuedOperation>>(data).toMutableList()
        } catch (_: Exception) {
            queue = mutableListOf()
        }
    }

    companion object {
        private const val STORAGE_KEY = "offline-queue"
        private const val MAX_ATTEMPTS = 10
        private const val BASE_RETRY_DELAY_MS = 1000L
        private const val MAX_RETRY_DELAY_MS = 60_000L

        /** Write methods eligible for offline queueing. */
        private val QUEUEABLE_METHODS = setOf("POST", "PUT", "PATCH", "DELETE")

        /** Whether an HTTP method is a write operation eligible for queueing. */
        fun isQueueableMethod(method: String): Boolean =
            method.uppercase() in QUEUEABLE_METHODS

        /**
         * Identity writes — sigchain links and PUK envelopes — are never queued.
         * A link is signed over its sequence number and the chain head, and a PUK
         * envelope upsert replaces the stored envelope for its generation, so a
         * replayed stale write could overwrite the envelope of the PUK the chain
         * actually names. Identity initialisation retries from the server's
         * current chain instead (see UserIdentityService).
         */
        fun isIdentityWrite(path: String): Boolean =
            path.startsWith("/api/puk/") ||
                (path.startsWith("/api/users/") && path.endsWith("/sigchain"))

        /** Whether a failed request should be queued for offline replay. */
        fun isQueueable(method: String, path: String): Boolean =
            isQueueableMethod(method) && !isIdentityWrite(path)
    }
}

