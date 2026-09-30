package org.llamenos.hotline.helpers

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * HTTP client for the test simulation endpoints defined in
 * `apps/worker/routes/dev.ts`.
 *
 * All endpoints require `X-Test-Secret` header and `ENVIRONMENT=development`.
 * The hub URL and test secret are read from instrumentation arguments
 * (`testHubUrl`, `testSecret`), matching the pattern in [BaseSteps].
 *
 * Uses [java.net.HttpURLConnection] to stay consistent with the existing
 * test infrastructure (see ScenarioHooks).
 */
object SimulationClient {

    private const val TAG = "SimulationClient"
    private const val CONNECT_TIMEOUT_MS = 30_000
    private const val READ_TIMEOUT_MS = 30_000

    private val json = Json { ignoreUnknownKeys = true }

    /** Hub base URL — mirrors [BaseSteps.TEST_HUB_URL]. */
    val hubUrl: String by lazy {
        val args = InstrumentationRegistry.getArguments()
        args.getString("testHubUrl", "http://192.168.50.95:3000")
    }

    /**
     * Test secret for `X-Test-Secret` header.
     * Passed via instrumentation argument `testSecret`, e.g.:
     *   adb shell am instrument -e testSecret "test-reset-secret" ...
     *
     * Defaults to "test-reset-secret" for local Docker Compose development.
     */
    val testSecret: String by lazy {
        val args = InstrumentationRegistry.getArguments()
        args.getString("testSecret", "test-reset-secret")
    }

    // ─── Response Types ─────────────────────────────────────────────

    @Serializable
    data class CallSimulationResponse(
        val ok: Boolean = false,
        val callId: String = "",
        val status: String = "",
        val error: String? = null,
        val detail: String? = null,
    )

    @Serializable
    data class MessageSimulationResponse(
        val ok: Boolean = false,
        val conversationId: String = "",
        val messageId: String = "",
        val error: String? = null,
        val detail: String? = null,
    )

    @Serializable
    data class StatusResponse(
        val ok: Boolean = false,
        val error: String? = null,
        val detail: String? = null,
    )

    // ─── Call Simulation ────────────────────────────────────────────

    /**
     * Simulate an incoming call from [callerNumber].
     *
     * Corresponds to `POST /api/test-simulate/incoming-call`.
     * Returns a [CallSimulationResponse] with the generated `callId`.
     */
    fun simulateIncomingCall(
        callerNumber: String,
        language: String? = null,
        hubId: String? = null,
    ): CallSimulationResponse {
        val bodyMap = buildMap {
            put("callerNumber", callerNumber)
            if (language != null) put("language", language)
            if (hubId != null) put("hubId", hubId)
        }
        val responseText = post("/api/test-simulate/incoming-call", toJson(bodyMap))
        return json.decodeFromString<CallSimulationResponse>(responseText)
    }

    /**
     * Simulate a volunteer answering a call.
     *
     * Corresponds to `POST /api/test-simulate/answer-call`.
     */
    fun simulateAnswerCall(callId: String, pubkey: String): CallSimulationResponse {
        val bodyMap = mapOf("callId" to callId, "pubkey" to pubkey)
        val responseText = post("/api/test-simulate/answer-call", toJson(bodyMap))
        return json.decodeFromString<CallSimulationResponse>(responseText)
    }

    /**
     * Simulate ending a call.
     *
     * Corresponds to `POST /api/test-simulate/end-call`.
     */
    fun simulateEndCall(callId: String): CallSimulationResponse {
        val bodyMap = mapOf("callId" to callId)
        val responseText = post("/api/test-simulate/end-call", toJson(bodyMap))
        return json.decodeFromString<CallSimulationResponse>(responseText)
    }

    /**
     * Simulate a call going to voicemail (unanswered).
     *
     * Corresponds to `POST /api/test-simulate/voicemail`.
     */
    fun simulateVoicemail(callId: String): CallSimulationResponse {
        val bodyMap = mapOf("callId" to callId)
        val responseText = post("/api/test-simulate/voicemail", toJson(bodyMap))
        return json.decodeFromString<CallSimulationResponse>(responseText)
    }

    // ─── Message Simulation ─────────────────────────────────────────

    /**
     * Simulate an incoming text message.
     *
     * Corresponds to `POST /api/test-simulate/incoming-message`.
     * [channel] defaults to "sms" on the server if omitted.
     */
    fun simulateIncomingMessage(
        senderNumber: String,
        body: String,
        channel: String? = null,
    ): MessageSimulationResponse {
        val bodyMap = buildMap {
            put("senderNumber", senderNumber)
            put("body", body)
            if (channel != null) put("channel", channel)
        }
        val responseText = post("/api/test-simulate/incoming-message", toJson(bodyMap))
        return json.decodeFromString<MessageSimulationResponse>(responseText)
    }

    /**
     * Simulate a delivery status update for an outbound message.
     *
     * Corresponds to `POST /api/test-simulate/delivery-status`.
     * [status] must be one of "delivered", "read", or "failed".
     */
    fun simulateDeliveryStatus(
        conversationId: String,
        messageId: String,
        status: String,
    ): StatusResponse {
        val bodyMap = mapOf(
            "conversationId" to conversationId,
            "messageId" to messageId,
            "status" to status,
        )
        val responseText = post("/api/test-simulate/delivery-status", toJson(bodyMap))
        return json.decodeFromString<StatusResponse>(responseText)
    }

    // ─── Identity Promotion ────────────────────────────────────────

    /**
     * Promote a pubkey to admin role on the backend.
     * The pubkey must belong to a registered volunteer (or will be created).
     *
     * Corresponds to `POST /api/test-promote-admin`.
     */
    fun promoteToAdmin(pubkey: String): StatusResponse {
        val body = """{"pubkey":"${escapeJson(pubkey)}"}"""
        val responseText = post("/api/test-promote-admin", body)
        return json.decodeFromString<StatusResponse>(responseText)
    }

    // ─── Shift Management ──────────────────────────────────────────

    /**
     * Create a shift covering the current time with the given volunteer.
     * Active call simulation requires on-shift volunteers for call routing.
     *
     * Corresponds to `POST /api/test-create-shift`.
     */
    fun createShift(pubkey: String, hubId: String? = null): StatusResponse {
        val fields = mutableListOf("\"pubkey\":\"${escapeJson(pubkey)}\"")
        if (hubId != null) fields.add("\"hubId\":\"${escapeJson(hubId)}\"")
        val body = "{${fields.joinToString(",")}}"
        val responseText = post("/api/test-create-shift", body)
        return json.decodeFromString<StatusResponse>(responseText)
    }

    // ─── Hub Membership ──────────────────────────────────────────

    /**
     * Add a user as a member of a hub with a given role.
     *
     * Corresponds to `POST /api/test-add-hub-member`.
     * Used by hub-switch tests to give the test user membership in specific hubs
     * without promoting to super-admin (which would show ALL hubs).
     *
     * [roleIds] has no default: the old default (`role-admin`) names a role that does not
     * exist (the hub admin is `role-hub-admin`), and a member with it cannot list any hub.
     */
    fun addHubMember(pubkey: String, hubId: String, roleIds: List<String>): StatusResponse {
        val roleIdsJson = roleIds.joinToString(",") { "\"${escapeJson(it)}\"" }
        val body = """{"pubkey":"${escapeJson(pubkey)}","hubId":"${escapeJson(hubId)}","roleIds":[$roleIdsJson]}"""
        val responseText = post("/api/test-add-hub-member", body)
        return json.decodeFromString<StatusResponse>(responseText)
    }

    // ─── Hub Management ───────────────────────────────────────────

    @Serializable
    data class HubResponse(
        val id: String = "",
        val name: String = "",
        val error: String? = null,
    )

    /**
     * Create an isolated test hub via the test endpoint.
     *
     * Calls POST /api/test-create-hub with X-Test-Secret header.
     * Returns the new hub's ID. Called once per Cucumber scenario in ScenarioHooks @Before.
     *
     * Hub is NOT deleted after the scenario — stale hubs accumulate and are purged periodically.
     */
    fun createTestHub(name: String? = null): HubResponse {
        val hubName = name ?: "android-test-${System.currentTimeMillis()}"
        val body = """{"name":"${escapeJson(hubName)}"}"""
        val responseText = post("/api/test-create-hub", body)
        return json.decodeFromString<HubResponse>(responseText)
    }

    // ─── HTTP Helpers ───────────────────────────────────────────────

    /**
     * Send a POST request to the test hub with JSON body and required headers.
     *
     * @throws SimulationException if the HTTP request fails or returns a non-2xx status.
     */
    private fun post(path: String, jsonBody: String): String {
        val url = URL("$hubUrl$path")
        Log.d(TAG, "POST $url")

        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Test-Secret", testSecret)

            conn.outputStream.use { os ->
                os.write(jsonBody.toByteArray(Charsets.UTF_8))
            }

            val code = conn.responseCode
            val body = if (code in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                val errorBody = try {
                    conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                } catch (_: IOException) { "" }
                Log.w(TAG, "POST $path returned HTTP $code: $errorBody")
                // Return the error body so the caller can parse the `error` field
                errorBody.ifBlank { """{"ok":false,"error":"HTTP $code"}""" }
            }

            Log.d(TAG, "Response ($code): ${body.take(500)}")
            return body
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Build a JSON object string from a [Map].
     * Using manual construction to avoid pulling in a JSON serializer dependency
     * just for request bodies (response parsing uses kotlinx.serialization).
     */
    private fun toJson(map: Map<String, String>): String {
        val entries = map.entries.joinToString(",") { (k, v) ->
            "\"${escapeJson(k)}\":\"${escapeJson(v)}\""
        }
        return "{$entries}"
    }

    private fun escapeJson(s: String): String =
        s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
}

/**
 * Exception thrown when a simulation endpoint request fails.
 */
class SimulationException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
