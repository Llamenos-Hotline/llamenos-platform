import Foundation

// MARK: - Request bodies

private struct StartOnboardingRequest: Encodable {
    let templateId: String?
}

private struct CompleteStepData: Encodable {
    let channelConfig: ChannelConfig?
}

private struct CompleteStepRequest: Encodable {
    let step: String
    let data: CompleteStepData?
}

private struct UpdateChannelRequest: Encodable {
    let channel: String
    let enabled: Bool
}

// MARK: - Response envelopes

// The payload types come from protocol codegen; these one-field envelopes mirror
// the inline `z.object({...})` wrappers in apps/worker/routes/hub-onboard.ts,
// which are not part of the protocol schema registry.

private struct OnboardingResponse: Decodable {
    let onboarding: HubOnboardingState
}

private struct OnboardingStatusResponse: Decodable {
    let onboarding: HubOnboardingState?
}

private struct HubSetupStatusResponse: Decodable {
    let status: HubSetupStatus
}

private struct HubUsageResponse: Decodable {
    let usage: HubUsage
}

private struct UpdateChannelResponse: Decodable {
    let channels: ChannelConfig
}

struct ProviderTemplateListResponse: Decodable {
    let templates: [ProviderTemplate]
}

// MARK: - HubOnboardAPI

/// Service wrapping hub onboarding and provider management API endpoints.
///
/// The hub self-service routes are mounted under `/api/hubs/:hubId/onboard`
/// (apps/worker/app.ts mounts `hub-onboard.ts` on the hub-scoped group):
/// - `POST   /onboard`                 — start (or restart) onboarding
/// - `GET    /onboard/status`          — current onboarding state, or null
/// - `PUT    /onboard/step`            — complete the current step
/// - `GET    /onboard/provider-status` — provider + channel setup status
/// - `GET    /onboard/usage`           — usage stats for the current period
/// - `PUT    /onboard/channels`        — enable or disable one channel
///
/// Provider templates are not hub-scoped: `GET /api/provider-templates`.
final class HubOnboardAPI {
    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    private func onboardPath(_ hubId: String, _ suffix: String = "") -> String {
        "/api/hubs/\(hubId)/onboard\(suffix)"
    }

    // MARK: - Onboarding

    /// Start onboarding with an optional template. Restarts a hub that already
    /// has state, leaving it on the server's first step (`template_selection`).
    func startOnboarding(hubId: String, templateId: String?) async throws -> HubOnboardingState {
        let response: OnboardingResponse = try await api.request(
            method: "POST",
            path: onboardPath(hubId),
            body: StartOnboardingRequest(templateId: templateId)
        )
        return response.onboarding
    }

    /// Get onboarding progress. `nil` when the hub has never started onboarding.
    func getOnboardingStatus(hubId: String) async throws -> HubOnboardingState? {
        let response: OnboardingStatusResponse = try await api.request(
            method: "GET",
            path: onboardPath(hubId, "/status")
        )
        return response.onboarding
    }

    /// Complete an onboarding step. `step` must be the server's current step —
    /// it rejects skipping forward and going back.
    func completeStep(
        hubId: String,
        step: String,
        channelConfig: ChannelConfig? = nil
    ) async throws -> HubOnboardingState {
        let response: OnboardingResponse = try await api.request(
            method: "PUT",
            path: onboardPath(hubId, "/step"),
            body: CompleteStepRequest(
                step: step,
                data: channelConfig.map { CompleteStepData(channelConfig: $0) }
            )
        )
        return response.onboarding
    }

    // MARK: - Provider Status

    /// Get the hub's provider and channel setup status.
    func getProviderStatus(hubId: String) async throws -> HubSetupStatus {
        let response: HubSetupStatusResponse = try await api.request(
            method: "GET",
            path: onboardPath(hubId, "/provider-status")
        )
        return response.status
    }

    // MARK: - Usage

    /// Get usage stats for the hub's current billing month.
    func getUsage(hubId: String) async throws -> HubUsage {
        let response: HubUsageResponse = try await api.request(
            method: "GET",
            path: onboardPath(hubId, "/usage")
        )
        return response.usage
    }

    // MARK: - Channels

    /// Enable or disable a single communication channel. Returns the hub's
    /// full channel config as the server now holds it.
    func updateChannel(hubId: String, channel: String, enabled: Bool) async throws -> ChannelConfig {
        let response: UpdateChannelResponse = try await api.request(
            method: "PUT",
            path: onboardPath(hubId, "/channels"),
            body: UpdateChannelRequest(channel: channel, enabled: enabled)
        )
        return response.channels
    }

    // MARK: - Provider Templates

    /// List available provider templates.
    func getProviderTemplates() async throws -> [ProviderTemplate] {
        let response: ProviderTemplateListResponse = try await api.request(
            method: "GET",
            path: "/api/provider-templates"
        )
        return response.templates
    }
}
