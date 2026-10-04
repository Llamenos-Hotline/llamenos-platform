package org.llamenos.hotline.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.CertificatePinner
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.ClearPushTokenRequest
import org.llamenos.hotline.model.OkResponse
import org.llamenos.hotline.model.RegisterDeviceRequest
import org.llamenos.hotline.model.RecoveryContributeRequest
import org.llamenos.hotline.model.RecoveryContributeResponse
import org.llamenos.hotline.model.RecoveryEnrollRequest
import org.llamenos.hotline.model.RecoveryEnvelopeRequest
import org.llamenos.hotline.model.RecoveryGroupInfo
import org.llamenos.hotline.model.RecoveryInitiateRequest
import org.llamenos.hotline.model.RecoveryInitiateResponse
import org.llamenos.hotline.model.RecoveryLivenessRequest
import org.llamenos.hotline.model.RecoverySessionStatus
import org.llamenos.hotline.model.RecoveryVerifyRequest
import org.llamenos.hotline.model.RecoveryVerifyResponse
import org.llamenos.hotline.service.OfflineQueue
import org.llamenos.protocol.HubKeyEnvelopeResponse
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

class ApiException(val code: Int, override val message: String) : Exception("HTTP $code: $message")

/**
 * REST API client for the llamenos Worker backend.
 *
 * Uses OkHttp with [AuthInterceptor] for automatic Schnorr authentication.
 * All requests are executed on [Dispatchers.IO] to avoid blocking the main thread.
 *
 * Serialization uses kotlinx.serialization with lenient JSON parsing
 * (unknown keys are ignored for forward compatibility).
 */
@Singleton
class ApiService @Inject constructor(
    authInterceptor: AuthInterceptor,
    retryInterceptor: RetryInterceptor,
    @PublishedApi internal val keystoreService: KeyValueStore,
    private val activeHubState: ActiveHubState,
) {

    /**
     * Dispatcher used for all HTTP I/O. Defaults to [Dispatchers.IO] in production.
     * Tests may override this to [kotlinx.coroutines.test.UnconfinedTestDispatcher] so that
     * the inline [request] function executes synchronously within the test scheduler instead
     * of dispatching to a real thread pool (which races with [advanceUntilIdle]).
     */
    @PublishedApi
    internal var ioDispatcher: CoroutineContext = Dispatchers.IO

    @PublishedApi
    internal var client: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(retryInterceptor)
        .addInterceptor(authInterceptor)
        .certificatePinner(certificatePinner)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    companion object {
        /**
         * Let's Encrypt ISRG Root X1 — RSA 4096, cross-signed by DST Root CA X3.
         * Pin targets the intermediate CA SPKI (not the leaf), so routine cert
         * renewal does not break pinning.
         *
         * Extracted via:
         *   curl -s https://letsencrypt.org/certs/isrgrootx1.pem \
         *     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
         *     | openssl dgst -sha256 -binary | base64
         */
        const val ISRG_ROOT_X1_HASH = "sha256/C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M="

        /**
         * Let's Encrypt ISRG Root X2 — ECDSA P-384 backup root.
         * Minimum 2 distinct CA pins for backup (RFC 7469 §2.5 recommendation).
         */
        const val ISRG_ROOT_X2_HASH = "sha256/diGVwiVYbubAI3RW4hB9xU8e/CH2GGvrTcuvhPy/MzA="

        /** Default pin hashes applied to whichever hub host the user configures. */
        val DEFAULT_PIN_HASHES = listOf(ISRG_ROOT_X1_HASH, ISRG_ROOT_X2_HASH)

        /**
         * Build a [CertificatePinner] for the given hostname with the provided
         * pin hashes. Used when the hub URL is configured or when dynamic pins
         * are fetched from the server.
         *
         * Hard fail: OkHttp CertificatePinner rejects mismatches unconditionally.
         * No cleartext fallback. No soft-fail mode.
         *
         * @param hostname The hub server hostname (e.g. "app.example.org")
         * @param hashes SHA-256 SPKI hashes prefixed with "sha256/"
         */
        fun buildPinner(hostname: String, hashes: List<String> = DEFAULT_PIN_HASHES): CertificatePinner {
            val builder = CertificatePinner.Builder()
            for (hash in hashes) {
                builder.add(hostname, hash)
            }
            return builder.build()
        }

        /** Initial no-op pinner — replaced when the hub URL is configured. */
        val certificatePinner: CertificatePinner = CertificatePinner.DEFAULT
    }

    /**
     * Offline write queue. Set by [LlamenosApp] after initialization.
     * When a write request fails with a network error, the operation is
     * automatically enqueued for replay when connectivity is restored.
     */
    var offlineQueue: OfflineQueue? = null

    /**
     * Rebuild the OkHttpClient with certificate pinning for the given hub hostname.
     * Called when the hub URL is configured (e.g. during onboarding or hub switch).
     *
     * Skips pinning for localhost / 127.0.0.1 (local development).
     *
     * @param hostname The hub server hostname (e.g. "app.example.org")
     * @param hashes Optional override pin hashes; defaults to Let's Encrypt CA pins
     */
    fun configurePinning(hostname: String, hashes: List<String> = DEFAULT_PIN_HASHES) {
        val isLocalhost = hostname == "localhost" || hostname == "127.0.0.1"
        val pinner = if (isLocalhost) CertificatePinner.DEFAULT else buildPinner(hostname, hashes)
        client = client.newBuilder()
            .certificatePinner(pinner)
            .build()
    }

    @PublishedApi
    internal val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        isLenient = true
    }

    /**
     * Execute an HTTP request and deserialize the response body.
     *
     * @param T The expected response type (must be @Serializable)
     * @param method HTTP method (GET, POST, PUT, DELETE, PATCH)
     * @param path API path (e.g., "/api/v1/identity")
     * @param body Optional request body (will be JSON-serialized)
     * @return Deserialized response of type T
     * @throws ApiException on non-2xx responses
     * @throws IOException on network errors
     */
    suspend inline fun <reified T> request(
        method: String,
        path: String,
        body: Any? = null,
    ): T = withContext(ioDispatcher) {
        val baseUrl = getBaseUrl()
        val url = "$baseUrl$path"

        val mediaType = "application/json; charset=utf-8".toMediaType()
        val requestBody = body?.let { bodyValue ->
            val serializer = serializer(bodyValue::class.java)
            @Suppress("UNCHECKED_CAST")
            json.encodeToString(serializer as kotlinx.serialization.SerializationStrategy<Any>, bodyValue)
                .toRequestBody(mediaType)
        }

        val httpMethod = method.uppercase()
        val request = Request.Builder()
            .url(url)
            .method(
                httpMethod,
                when {
                    requestBody != null -> requestBody
                    httpMethod in listOf("POST", "PUT", "PATCH") -> "".toRequestBody(mediaType)
                    else -> null
                }
            )
            .build()

        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            // On network error for write operations, enqueue for offline replay
            if (OfflineQueue.isQueueableMethod(httpMethod)) {
                val bodyString = body?.let { bodyValue ->
                    val serializer = serializer(bodyValue::class.java)
                    @Suppress("UNCHECKED_CAST")
                    json.encodeToString(serializer as kotlinx.serialization.SerializationStrategy<Any>, bodyValue)
                }
                offlineQueue?.enqueue(path, httpMethod, bodyString)
            }
            throw e
        }

        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: response.message
            throw ApiException(response.code, errorBody)
        }

        val responseBody = response.body?.string()
            ?: throw ApiException(response.code, "Empty response body")

        json.decodeFromString<T>(responseBody)
    }

    /**
     * Execute a request that returns no meaningful body (e.g., DELETE).
     */
    suspend fun requestNoContent(
        method: String,
        path: String,
        body: Any? = null,
    ): Unit = withContext(ioDispatcher) {
        val baseUrl = getBaseUrl()
        val url = "$baseUrl$path"

        val mediaType = "application/json; charset=utf-8".toMediaType()
        val requestBody = body?.let { bodyValue ->
            val serializer = serializer(bodyValue::class.java)
            @Suppress("UNCHECKED_CAST")
            json.encodeToString(serializer as kotlinx.serialization.SerializationStrategy<Any>, bodyValue)
                .toRequestBody(mediaType)
        }

        val httpMethod = method.uppercase()
        val request = Request.Builder()
            .url(url)
            .method(
                httpMethod,
                when {
                    requestBody != null -> requestBody
                    httpMethod in listOf("POST", "PUT", "PATCH") -> "".toRequestBody(mediaType)
                    else -> null
                }
            )
            .build()

        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            // On network error for write operations, enqueue for offline replay
            if (OfflineQueue.isQueueableMethod(httpMethod)) {
                val bodyString = body?.let { bodyValue ->
                    val serializer = serializer(bodyValue::class.java)
                    @Suppress("UNCHECKED_CAST")
                    json.encodeToString(serializer as kotlinx.serialization.SerializationStrategy<Any>, bodyValue)
                }
                offlineQueue?.enqueue(path, httpMethod, bodyString)
            }
            throw e
        }

        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: response.message
            throw ApiException(response.code, errorBody)
        }
    }

    /**
     * Execute a request with a pre-serialized JSON string body.
     *
     * Used by [OfflineQueue] during replay — the body was already serialized
     * when the operation was originally enqueued, so we send it as-is.
     *
     * @param method HTTP method
     * @param path API path
     * @param rawJsonBody Pre-serialized JSON string, or null
     */
    suspend fun requestRawNoContent(
        method: String,
        path: String,
        rawJsonBody: String? = null,
    ): Unit = withContext(ioDispatcher) {
        val baseUrl = getBaseUrl()
        val url = "$baseUrl$path"

        val mediaType = "application/json; charset=utf-8".toMediaType()
        val httpMethod = method.uppercase()
        val requestBody = rawJsonBody?.toRequestBody(mediaType)

        val request = Request.Builder()
            .url(url)
            .method(
                httpMethod,
                when {
                    requestBody != null -> requestBody
                    httpMethod in listOf("POST", "PUT", "PATCH") -> "".toRequestBody(mediaType)
                    else -> null
                }
            )
            .build()

        val response = client.newCall(request).execute()

        if (!response.isSuccessful) {
            val errorBody = response.body?.string() ?: response.message
            throw ApiException(response.code, errorBody)
        }
    }

    /**
     * Returns the path prefixed with /hubs/{activeHubId}.
     * Falls back to the bare path if no hub is currently active.
     */
    fun hp(path: String): String {
        require(path.startsWith("/")) { "hp() path must start with '/': $path" }
        val hubId = activeHubState.activeHubId.value ?: return path
        return hubPath(hubId, path)
    }

    /**
     * Returns the path prefixed with /hubs/{hubId} for an explicit hub — use this when
     * acting on something that belongs to a specific hub (e.g. a call that rang on a hub
     * other than the active one) rather than on the active browsing context.
     */
    fun hubPath(hubId: String, path: String): String {
        require(path.startsWith("/")) { "hubPath() path must start with '/': $path" }
        return if (path.startsWith("/api/")) {
            "/api/hubs/$hubId${path.removePrefix("/api")}"
        } else {
            "/hubs/$hubId$path"
        }
    }

    /**
     * Base URL of the configured hub server, e.g. `https://hub.example.org`.
     * @throws IllegalStateException if no hub URL is configured
     */
    fun hubBaseUrl(): String = getBaseUrl()

    /**
     * HTTP client for the WebSocket relay. Shares the certificate pinner and connect
     * timeout of the API client, but has no read timeout (the socket is long-lived), a
     * 30s keepalive ping, and none of the per-request interceptors (the relay
     * authenticates in-band with an Ed25519 challenge, not with request headers).
     */
    fun relayHttpClient(): OkHttpClient = client.newBuilder()
        .apply { interceptors().clear() }
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    // ---- Device registration API ----

    /**
     * Register or update this device's UnifiedPush endpoint on the backend.
     * The [RegisterDeviceRequest.pushToken] is the full ntfy endpoint URL.
     * Idempotent — safe to call on every new endpoint assignment.
     */
    suspend fun registerPushEndpoint(body: RegisterDeviceRequest): Unit =
        requestNoContent("POST", "/api/devices/register", body)

    /**
     * Remove this device's push endpoint from the backend.
     * Called when the UnifiedPush distributor unregisters this device,
     * so the backend stops attempting delivery to the stale endpoint.
     */
    suspend fun clearPushEndpoint(pushToken: String): Unit =
        requestNoContent("DELETE", "/api/devices/push-token", ClearPushTokenRequest(pushToken))

    /**
     * Fetch the E2EE key envelope for a specific hub.
     * Used during hub selection to decrypt the hub key.
     * Returns HubKeyEnvelopeResponse wrapping the HPKE envelope fields.
     */
    suspend fun getHubKey(hubId: String): HubKeyEnvelopeResponse {
        return request("GET", "/api/hubs/$hubId/key")
    }

    // ---- Recovery Group API ----

    suspend fun enrollRecoveryGroup(body: RecoveryEnrollRequest): OkResponse =
        request("POST", "/api/recovery-group/enroll", body)

    suspend fun getRecoveryGroup(hubId: String): RecoveryGroupInfo =
        request("GET", "/api/recovery-group/$hubId")

    suspend fun initiateRecovery(body: RecoveryInitiateRequest): RecoveryInitiateResponse =
        request("POST", "/api/recovery-group/initiate", body)

    suspend fun verifyRecoveryCode(body: RecoveryVerifyRequest): RecoveryVerifyResponse =
        request("POST", "/api/recovery-group/initiate/verify", body)

    suspend fun getRecoverySession(sessionId: String): RecoverySessionStatus =
        request("GET", "/api/recovery-group/session/$sessionId")

    suspend fun contributeRecoveryShare(
        sessionId: String,
        body: RecoveryContributeRequest,
    ): RecoveryContributeResponse =
        request("POST", "/api/recovery-group/session/$sessionId/contribute", body)

    suspend fun cancelRecoverySession(sessionId: String): OkResponse =
        request("POST", "/api/recovery-group/session/$sessionId/cancel")

    suspend fun storeUserRecoveryEnvelope(body: RecoveryEnvelopeRequest): OkResponse =
        request("POST", "/api/recovery-group/user-envelope", body)

    suspend fun submitShareLivenessProof(body: RecoveryLivenessRequest): OkResponse =
        request("POST", "/api/recovery-group/shares/liveness", body)

    /** Tracks the hostname the pinner was last configured for. */
    @PublishedApi
    internal var pinnedHostname: String? = null

    /**
     * Get the configured hub URL from secure storage.
     * Lazily configures certificate pinning on first call or when the hub URL changes.
     */
    @PublishedApi
    internal fun getBaseUrl(): String {
        val url = keystoreService.retrieve(KeystoreService.KEY_HUB_URL)
            ?: throw IllegalStateException("Hub URL not configured")

        // Extract hostname and configure pinning if needed
        val hostname = try {
            java.net.URI(url).host ?: url
        } catch (_: Exception) {
            url
        }
        if (hostname != pinnedHostname) {
            configurePinning(hostname)
            pinnedHostname = hostname
        }

        return url
    }
}
