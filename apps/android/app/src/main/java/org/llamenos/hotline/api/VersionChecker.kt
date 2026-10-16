package org.llamenos.hotline.api

import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Response from `GET /api/config` — only the fields needed for version checking.
 * Extra fields are ignored thanks to `ignoreUnknownKeys = true` in [ApiService.json].
 */
@Serializable
data class AppConfigResponse(
    val hotlineName: String = "",
    val apiVersion: Int = 1,
    val minApiVersion: Int = 1,
    /** Server-advertised WebSocket relay endpoint (e.g. `/ws`); null when no relay is configured. */
    val wsRelayUrl: String? = null,
)

/**
 * Checks the client's compiled API version against the server's `/api/config`
 * response to determine whether the app needs updating.
 *
 * Called on app launch. Returns [VersionStatus.Unknown] on network failure
 * so the app is not blocked when offline.
 */
@Singleton
class VersionChecker @Inject constructor(
    private val apiService: ApiService,
) {
    /**
     * Result of comparing the client's API version against the server's config.
     */
    sealed class VersionStatus {
        /** Client is up-to-date. */
        data object UpToDate : VersionStatus()

        /** A newer version is available but not required. */
        data class UpdateAvailable(val latestVersion: Int) : VersionStatus()

        /** Client is too old and must update before continuing. */
        data class ForceUpdate(val minVersion: Int) : VersionStatus()

        /** Version check could not be performed (network error, etc.). */
        data object Unknown : VersionStatus()
    }

    companion object {
        /**
         * The API version this client is compiled against.
         * Must match the server's `CURRENT_API_VERSION` in `apps/worker/lib/api-versions.ts`.
         */
        const val API_VERSION = 1
    }

    /**
     * Fetch `/api/config` and compare the server's version requirements
     * against this client's compiled [API_VERSION].
     */
    suspend fun check(): VersionStatus {
        return try {
            val config = apiService.request<AppConfigResponse>(
                method = "GET",
                path = "/api/config",
            )
            when {
                API_VERSION < config.minApiVersion ->
                    VersionStatus.ForceUpdate(config.minApiVersion)
                API_VERSION < config.apiVersion ->
                    VersionStatus.UpdateAvailable(config.apiVersion)
                else -> VersionStatus.UpToDate
            }
        } catch (_: Exception) {
            VersionStatus.Unknown
        }
    }
}
