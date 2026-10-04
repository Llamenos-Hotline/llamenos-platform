package org.llamenos.hotline.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.protocol.ChannelConfig
import org.llamenos.protocol.HubOnboardingState
import org.llamenos.protocol.HubSetupStatus
import org.llamenos.protocol.HubUsage
import org.llamenos.protocol.ProviderTemplate
import javax.inject.Inject
import javax.inject.Singleton

// ── Response / request wrappers ─────────────────────────────────────────────
//
// The payload types come from protocol codegen; these one-field envelopes mirror
// the inline `z.object({...})` wrappers in apps/worker/routes/hub-onboard.ts,
// which are not part of the protocol schema registry.

@Serializable
data class ProviderTemplatesResponse(
    val templates: List<ProviderTemplate>,
)

@Serializable
data class OnboardingResponse(
    val onboarding: HubOnboardingState,
)

@Serializable
data class ProviderStatusResponse(
    val status: HubSetupStatus,
)

@Serializable
data class HubUsageResponse(
    val usage: HubUsage,
)

@Serializable
data class StartOnboardingRequest(
    val templateId: String? = null,
)

@Serializable
data class CompleteStepData(
    val channelConfig: ChannelConfig? = null,
)

@Serializable
data class CompleteStepRequest(
    val step: String,
    val data: CompleteStepData? = null,
)

@Serializable
data class UpdateChannelRequest(
    val channel: String,
    val enabled: Boolean,
)

@Serializable
data class UpdateChannelResponse(
    val channels: ChannelConfig,
)

/**
 * Repository for hub onboarding and communications management.
 *
 * Wraps the hub self-service API, mounted under /api/hubs/:hubId/onboard:
 * - POST /onboard — start (or restart) onboarding
 * - PUT /onboard/step — complete the current step
 * - GET /onboard/provider-status — provider + channel status
 * - GET /onboard/usage — usage stats for the current period
 * - PUT /onboard/channels — enable/disable one channel
 * and GET /api/provider-templates — list templates.
 */
@Singleton
class HubOnboardApi @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
) {

    private fun onboardPath(suffix: String = ""): String {
        val hubId = activeHubState.activeHubId.value
            ?: throw IllegalStateException("No active hub selected")
        return "/api/hubs/$hubId/onboard$suffix"
    }

    // ── Onboarding ──────────────────────────────────────────────────────────

    suspend fun startOnboarding(
        templateId: String? = null,
    ): Result<HubOnboardingState> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request<OnboardingResponse>(
                "POST",
                onboardPath(),
                StartOnboardingRequest(templateId = templateId),
            ).onboarding
        }
    }

    suspend fun completeStep(
        step: String,
        channelConfig: ChannelConfig? = null,
    ): Result<HubOnboardingState> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request<OnboardingResponse>(
                "PUT",
                onboardPath("/step"),
                CompleteStepRequest(
                    step = step,
                    data = channelConfig?.let { CompleteStepData(channelConfig = it) },
                ),
            ).onboarding
        }
    }

    // ── Provider & Usage ────────────────────────────────────────────────────

    suspend fun getProviderStatus(): Result<HubSetupStatus> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request<ProviderStatusResponse>("GET", onboardPath("/provider-status")).status
        }
    }

    suspend fun getUsage(): Result<HubUsage> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request<HubUsageResponse>("GET", onboardPath("/usage")).usage
        }
    }

    // ── Channels ────────────────────────────────────────────────────────────

    suspend fun updateChannel(
        channel: String,
        enabled: Boolean,
    ): Result<ChannelConfig> = withContext(Dispatchers.IO) {
        runCatching {
            apiService.request<UpdateChannelResponse>(
                "PUT",
                onboardPath("/channels"),
                UpdateChannelRequest(channel = channel, enabled = enabled),
            ).channels
        }
    }

    // ── Templates ───────────────────────────────────────────────────────────

    suspend fun getTemplates(): Result<List<ProviderTemplate>> = withContext(Dispatchers.IO) {
        runCatching {
            val response: ProviderTemplatesResponse = apiService.request(
                "GET",
                "/api/provider-templates",
            )
            response.templates
        }
    }
}
