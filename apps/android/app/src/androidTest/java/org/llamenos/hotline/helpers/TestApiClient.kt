package org.llamenos.hotline.helpers

import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Thin E2E test client that seeds data via POST /api/test-seed.
 *
 * All entity type definitions, envelope construction, and multi-step
 * orchestration lives server-side. This client sends a declarative spec
 * and gets back IDs for created resources.
 *
 * Dev-only: the /test-seed endpoint returns 404 outside ENVIRONMENT=development.
 */
class TestApiClient(
    private val baseUrl: String,
    private val testSecret: String,
) {
    companion object {
        private const val TAG = "TestApiClient"
        private const val CONNECT_TIMEOUT_MS = 30_000
        private const val READ_TIMEOUT_MS = 30_000

        private val json = Json { ignoreUnknownKeys = true }
    }

    // ─── Seed Spec Types ──────────────────────────────────────────────

    @Serializable
    data class SeedPermissions(
        val grantVolunteerCms: Boolean = false,
        val enableCaseManagement: Boolean = false,
    )

    @Serializable
    data class SeedEntityType(
        val template: String,
        val records: Int = 0,
        val assignTo: List<String> = emptyList(),
    )

    @Serializable
    data class SeedReportType(
        val template: String,
        val triageReports: Int = 0,
    )

    @Serializable
    data class SeedShift(
        val pubkey: String,
    )

    @Serializable
    data class SeedMember(
        val pubkey: String,
        val roleIds: List<String> = listOf("role-volunteer"),
    )

    @Serializable
    data class SeedContact(
        val displayName: String,
        val contactType: String = "person",
    )

    @Serializable
    data class SeedSpec(
        val hubId: String,
        val adminSeed: String,
        val permissions: SeedPermissions = SeedPermissions(),
        val entityTypes: List<SeedEntityType> = emptyList(),
        val reportTypes: List<SeedReportType> = emptyList(),
        val shifts: List<SeedShift> = emptyList(),
        val members: List<SeedMember> = emptyList(),
        val contacts: List<SeedContact> = emptyList(),
    )

    // ─── Seed Result Types ────────────────────────────────────────────

    @Serializable
    data class EntityTypeResult(
        val id: String = "",
        val name: String = "",
        val category: String = "",
        val defaultStatus: String = "",
    )

    @Serializable
    data class RecordResult(
        val id: String = "",
        val entityTypeId: String = "",
        val caseNumber: String? = null,
    )

    @Serializable
    data class IdResult(val id: String = "")

    @Serializable
    data class PubkeyResult(val pubkey: String = "")

    @Serializable
    data class SeedResult(
        val ok: Boolean = false,
        val entityTypes: List<EntityTypeResult> = emptyList(),
        val records: List<RecordResult> = emptyList(),
        val reportTypes: List<IdResult> = emptyList(),
        val triageReports: List<IdResult> = emptyList(),
        val shifts: List<IdResult> = emptyList(),
        val contacts: List<IdResult> = emptyList(),
        val members: List<PubkeyResult> = emptyList(),
        val errors: List<String> = emptyList(),
    )

    // ─── Core API ─────────────────────────────────────────────────────

    /**
     * Seed test data via the declarative /api/test-seed endpoint.
     * Returns IDs for all created resources.
     */
    fun seed(spec: SeedSpec): SeedResult {
        val body = json.encodeToString(SeedSpec.serializer(), spec)
        Log.i(TAG, "seed: hubId=${spec.hubId}, entityTypes=${spec.entityTypes.size}, " +
            "records=${spec.entityTypes.sumOf { it.records }}")
        val response = post("/api/test-seed", body)
        val result = json.decodeFromString(SeedResult.serializer(), response)
        if (result.errors.isNotEmpty()) {
            Log.w(TAG, "seed warnings: ${result.errors}")
        }
        Log.i(TAG, "seed result: ok=${result.ok}, entityTypes=${result.entityTypes.size}, " +
            "records=${result.records.size}")
        return result
    }

    /**
     * POST with X-Test-Secret header. All /test-* endpoints use this auth.
     */
    fun post(path: String, body: String): String {
        val url = URL("$baseUrl$path")
        Log.d(TAG, "POST $url")

        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Test-Secret", testSecret)
            conn.doOutput = true
            conn.outputStream.use { os ->
                os.write(body.toByteArray(Charsets.UTF_8))
            }

            val code = conn.responseCode
            val responseBody = if (code in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                val errorBody = try {
                    conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                } catch (_: IOException) { "" }
                Log.e(TAG, "POST $path returned HTTP $code: $errorBody")
                throw SimulationException("POST $path failed with HTTP $code: $errorBody")
            }

            Log.d(TAG, "Response ($code): ${responseBody.take(500)}")
            return responseBody
        } finally {
            conn.disconnect()
        }
    }
}
