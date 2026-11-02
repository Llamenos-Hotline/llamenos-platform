package org.llamenos.hotline.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.protocol.A2PRegistrationState
import org.llamenos.protocol.AvailableNumber
import org.llamenos.protocol.NumberProvisionRequest
import org.llamenos.protocol.NumberSearchQuery
import org.llamenos.protocol.OauthFlowState
import org.llamenos.protocol.OwnedNumber
import org.llamenos.protocol.ProviderStatusResponse
import org.llamenos.protocol.SignalRegistrationState
import org.llamenos.protocol.StartOAuthResponse
import org.llamenos.protocol.WebhookConfigState
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Result of testing a provider connection.
 */
data class TestConnectionResult(
    val connected: Boolean,
    val latencyMs: Long,
    val accountName: String? = null,
    val error: String? = null,
    val errorType: String? = null,
)

/**
 * Request to start Signal registration.
 */
data class SignalRegisterRequest(
    val bridgeUrl: String,
    val phoneNumber: String,
    val method: String = "sms",
    val hubId: String? = null,
)

/**
 * Request to verify Signal registration code.
 */
data class SignalVerifyRequest(
    val registrationId: String,
    val code: String,
)

/**
 * Request to unregister Signal.
 */
data class SignalUnregisterRequest(
    val registrationId: String,
)

/**
 * A2P brand information.
 */
data class BrandInfo(
    val entityType: String,
    val companyName: String,
    val ein: String,
    val phone: String,
    val street: String,
    val city: String,
    val state: String,
    val postalCode: String,
    val country: String,
    val email: String,
    val website: String? = null,
    val vertical: String? = null,
)

/**
 * Repository for provider setup operations.
 *
 * Wraps the provider-setup API endpoints with suspend functions and [Result] types.
 * All calls are made on [Dispatchers.IO] via [ApiService.request].
 */
@Singleton
class ProviderSetupRepository @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
) {

    /** The hub being configured, or null when none is active. */
    fun activeHubIdOrNull(): String? = activeHubState.activeHubId.value

    private fun hubPath(path: String): String {
        val hubId = activeHubState.activeHubId.value
        return if (hubId != null) {
            "$path?hubId=$hubId"
        } else {
            path
        }
    }

    // ── OAuth ────────────────────────────────────────────────────────────────

    suspend fun startOAuth(
        provider: String,
        callbackScheme: String = "llamenos://",
        state: String? = null,
        hubId: String? = null,
    ): Result<StartOAuthResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val body = buildMap {
                put("provider", provider)
                put("redirectUrl", "${callbackScheme}oauth/callback")
                put("hubId", hubId ?: activeHubState.activeHubId.value)
                if (state != null) put("state", state)
            }
            apiService.request("POST", "/api/provider-setup/oauth/start", body)
        }
    }

    suspend fun getOAuthStatus(state: String): Result<OauthFlowState> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request("GET", "/api/provider-setup/oauth/status/$state")
        }
    }

    // ── Provider Configuration ───────────────────────────────────────────────

    suspend fun configureProvider(
        provider: String,
        credentials: Map<String, String>,
        hubId: String? = null,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "provider" to provider,
                "credentials" to credentials,
                "hubId" to (hubId ?: activeHubState.activeHubId.value),
            )
            apiService.requestNoContent("POST", "/api/provider-setup/configure", body)
        }
    }

    suspend fun testProvider(
        provider: String,
        hubId: String? = null,
    ): Result<TestConnectionResult> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "provider" to provider,
                "hubId" to (hubId ?: activeHubState.activeHubId.value),
            )
            apiService.request<Map<String, Any>>("POST", "/api/provider-setup/test", body).let { map ->
                @Suppress("UNCHECKED_CAST")
                TestConnectionResult(
                    connected = map["connected"] as? Boolean ?: false,
                    latencyMs = (map["latencyMs"] as? Number)?.toLong() ?: 0L,
                    accountName = map["accountName"] as? String,
                    error = map["error"] as? String,
                    errorType = map["errorType"] as? String,
                )
            }
        }
    }

    suspend fun getProviderStatus(
        provider: String,
        hubId: String? = null,
    ): Result<ProviderStatusResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val path = hubPath("/api/provider-setup/status/$provider")
            apiService.request("GET", path)
        }
    }

    // ── Phone Numbers ────────────────────────────────────────────────────────

    suspend fun listPhoneNumbers(
        provider: String,
        hubId: String? = null,
    ): Result<List<OwnedNumber>> = withContext(Dispatchers.IO) {
        runCatching {
            val path = hubPath("/api/provider-setup/phone-numbers?provider=$provider")
            @Suppress("UNCHECKED_CAST")
            val response = apiService.request<Map<String, Any>>("GET", path)
            val numbers = response["numbers"] as? List<Map<String, Any>> ?: emptyList()
            // Re-serialize each number individually to leverage kotlinx.serialization
            numbers.map { numberMap ->
                apiService.json.decodeFromString(
                    OwnedNumber.serializer(),
                    apiService.json.encodeToString(numberMap),
                )
            }
        }
    }

    suspend fun searchPhoneNumbers(
        query: NumberSearchQuery,
    ): Result<List<AvailableNumber>> = withContext(Dispatchers.IO) {
        runCatching {
            val response = apiService.request<Map<String, Any>>("POST", "/api/provider-setup/phone-numbers/search", query)
            @Suppress("UNCHECKED_CAST")
            val numbers = response["numbers"] as? List<Map<String, Any>> ?: emptyList()
            numbers.map { numberMap ->
                apiService.json.decodeFromString(
                    AvailableNumber.serializer(),
                    apiService.json.encodeToString(numberMap),
                )
            }
        }
    }

    suspend fun provisionPhoneNumber(
        request: NumberProvisionRequest,
    ): Result<OwnedNumber> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request("POST", "/api/provider-setup/phone-numbers/provision", request)
        }
    }

    // ── Webhooks ─────────────────────────────────────────────────────────────

    suspend fun configureWebhooks(
        provider: String,
        phoneNumber: String,
        hubId: String? = null,
    ): Result<WebhookConfigState> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "provider" to provider,
                "numberId" to phoneNumber,
                "enableSms" to true,
                "hubId" to (hubId ?: activeHubState.activeHubId.value),
            )
            apiService.request("POST", "/api/provider-setup/configure-webhooks", body)
        }
    }

    // ── Signal ───────────────────────────────────────────────────────────────

    suspend fun startSignalRegistration(
        config: SignalRegisterRequest,
        hubId: String? = null,
    ): Result<SignalRegistrationState> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "bridgeUrl" to config.bridgeUrl,
                "phoneNumber" to config.phoneNumber,
                "method" to config.method,
                "hubId" to (hubId ?: activeHubState.activeHubId.value),
            )
            apiService.request("POST", "/api/provider-setup/signal/register", body)
        }
    }

    suspend fun getSignalStatus(
        hubId: String? = null,
    ): Result<SignalRegistrationState> = withContext(Dispatchers.IO) {
        runCatching {
            val path = hubPath("/api/provider-setup/signal/status")
            apiService.request("GET", path)
        }
    }

    suspend fun verifySignalCode(
        registrationId: String,
        code: String,
    ): Result<SignalRegistrationState> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "registrationId" to registrationId,
                "code" to code,
            )
            apiService.request("POST", "/api/provider-setup/signal/verify", body)
        }
    }

    suspend fun unregisterSignal(
        registrationId: String,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.requestNoContent(
                "DELETE",
                "/api/provider-setup/signal/unregister?registrationId=$registrationId",
            )
        }
    }

    // ── A2P ──────────────────────────────────────────────────────────────────

    suspend fun submitA2PBrand(
        info: BrandInfo,
        hubId: String? = null,
    ): Result<A2PRegistrationState> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "providerType" to "twilio",
                "brandInfo" to mapOf(
                    "entityType" to info.entityType,
                    "companyName" to info.companyName,
                    "ein" to info.ein,
                    "phone" to info.phone,
                    "street" to info.street,
                    "city" to info.city,
                    "state" to info.state,
                    "postalCode" to info.postalCode,
                    "country" to info.country,
                    "email" to info.email,
                    "website" to info.website,
                    "vertical" to info.vertical,
                ),
                "hubId" to (hubId ?: activeHubState.activeHubId.value),
            )
            apiService.request("POST", "/api/provider-setup/a2p/brand", body)
        }
    }

    suspend fun getA2PStatus(
        hubId: String? = null,
    ): Result<A2PRegistrationState> = withContext(Dispatchers.IO) {
        runCatching {
            val path = hubPath("/api/provider-setup/a2p/status")
            apiService.request("GET", path)
        }
    }

    suspend fun skipA2P(
        hubId: String? = null,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val body = mapOf(
                "providerType" to "twilio",
                "hubId" to (hubId ?: activeHubState.activeHubId.value),
            )
            apiService.requestNoContent("POST", "/api/provider-setup/a2p/skip", body)
        }
    }
}
