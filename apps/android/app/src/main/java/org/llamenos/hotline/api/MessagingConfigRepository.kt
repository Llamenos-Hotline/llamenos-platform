package org.llamenos.hotline.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

@Serializable
data class SMSConfigDto(
    val enabled: Boolean = false,
    val autoResponse: String? = null,
    val afterHoursResponse: String? = null,
)

@Serializable
data class WhatsAppConfigDto(
    val integrationMode: String = "twilio",
    val phoneNumberId: String? = null,
    val businessAccountId: String? = null,
    val accessToken: String? = null,
    val verifyToken: String? = null,
    val appSecret: String? = null,
    val autoResponse: String? = null,
    val afterHoursResponse: String? = null,
)

@Serializable
data class SignalConfigDto(
    val bridgeUrl: String = "",
    val bridgeApiKey: String = "",
    val webhookSecret: String = "",
    val registeredNumber: String = "",
    val trustMode: String? = null,
    val autoResponse: String? = null,
    val afterHoursResponse: String? = null,
)

@Serializable
data class TelegramConfigDto(
    val enabled: Boolean = false,
    val botToken: String = "",
    val webhookSecret: String? = null,
    val botUsername: String? = null,
    val autoResponse: String? = null,
    val afterHoursResponse: String? = null,
)

@Serializable
data class RCSConfigDto(
    val agentId: String = "",
    val serviceAccountKey: String = "",
    val webhookSecret: String? = null,
    val fallbackToSms: Boolean = true,
    val autoResponse: String? = null,
    val afterHoursResponse: String? = null,
)

@Serializable
data class MessagingConfigDto(
    val enabledChannels: List<String> = emptyList(),
    val sms: SMSConfigDto? = null,
    val whatsapp: WhatsAppConfigDto? = null,
    val signal: SignalConfigDto? = null,
    val rcs: RCSConfigDto? = null,
    val telegram: TelegramConfigDto? = null,
    val autoAssign: Boolean = true,
    val inactivityTimeout: Int = 60,
    val maxConcurrentPerUser: Int = 3,
    val preferSignalDelivery: Boolean? = null,
    val smsContentMode: String? = null,
)

@Serializable
data class ConnectionTestDto(val connected: Boolean)

@Serializable
data class A2pRegistrationDto(
    val id: String = "",
    val hubId: String = "",
    val providerType: String = "",
    val brandStatus: String = "not_submitted",
    val campaignStatus: String = "not_submitted",
    val brandSidMasked: String? = null,
    val campaignSidMasked: String? = null,
    val error: String? = null,
    val submittedAt: String? = null,
    val approvedAt: String? = null,
)

@Serializable
data class MessagingChannelTestRequest(val channel: String)

@Serializable
data class A2pBrandRequest(val hubId: String, val brandInfo: JsonObject)

@Serializable
data class A2pCampaignRequest(val registrationId: String, val hubId: String, val campaignInfo: JsonObject)

@Serializable
data class A2pSkipRequest(val hubId: String)

/**
 * Encode a screen-built `Map<String, Any?>` as JSON. kotlinx.serialization has no
 * serializer for a map of `Any`, so handing one to [ApiService.request] throws before the
 * request is sent — which is how every channel save failed even with the right path.
 */
internal fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (key, value) -> key.toString() to value.toJsonElement() })
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    else -> throw IllegalArgumentException("Cannot encode ${this::class.simpleName} as JSON")
}

private fun Map<String, Any?>.toJsonObject(): JsonObject = toJsonElement() as JsonObject

/**
 * Messaging channel settings (`/api/settings/messaging`, apps/worker/routes/settings.ts) and
 * A2P 10DLC registration (`/api/provider-setup/a2p/…`, apps/worker/routes/provider-setup.ts).
 */
@Singleton
class MessagingConfigRepository @Inject constructor(
    private val apiService: ApiService,
) {
    suspend fun getConfig(): MessagingConfigDto {
        return apiService.request("GET", "/api/settings/messaging")
    }

    /** PATCH a partial config — only the keys in [updates] change on the server. */
    suspend fun updateConfig(updates: Map<String, Any?>): MessagingConfigDto {
        return apiService.request("PATCH", "/api/settings/messaging", updates.toJsonObject())
    }

    suspend fun testChannel(channel: String): Boolean {
        val result: ConnectionTestDto = apiService.request(
            "POST",
            "/api/settings/messaging/test",
            MessagingChannelTestRequest(channel),
        )
        return result.connected
    }

    /**
     * The hub's A2P registration, or null when the hub has never submitted one —
     * the route answers 404 for exactly that case. Every other failure (403,
     * 5xx, network) propagates so the screen can show it.
     */
    suspend fun getA2pStatus(hubId: String): A2pRegistrationDto? {
        return try {
            apiService.request("GET", "/api/provider-setup/a2p/status?hubId=$hubId")
        } catch (e: ApiException) {
            if (e.code == 404) null else throw e
        }
    }

    suspend fun submitBrand(hubId: String, brandInfo: Map<String, Any>): A2pRegistrationDto {
        return apiService.request(
            "POST",
            "/api/provider-setup/a2p/brand",
            A2pBrandRequest(hubId = hubId, brandInfo = brandInfo.toJsonObject()),
        )
    }

    suspend fun submitCampaign(
        registrationId: String,
        hubId: String,
        campaignInfo: Map<String, Any>,
    ): A2pRegistrationDto {
        return apiService.request(
            "POST",
            "/api/provider-setup/a2p/campaign",
            A2pCampaignRequest(registrationId = registrationId, hubId = hubId, campaignInfo = campaignInfo.toJsonObject()),
        )
    }

    suspend fun skipA2p(hubId: String): A2pRegistrationDto {
        return apiService.request("POST", "/api/provider-setup/a2p/skip", A2pSkipRequest(hubId))
    }
}
