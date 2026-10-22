import Foundation
import AuthenticationServices

// MARK: - ProviderInfo

/// UI model describing a telephony provider and its capabilities.
struct ProviderInfo: Identifiable {
    let id: SharedProviderType
    var displayName: String { id.displayName }
    var icon: String { id.iconName }
    let capabilities: [ProviderCapability]
    let supportsOAuth: Bool

    static let all: [ProviderInfo] = [
        ProviderInfo(id: .twilio, capabilities: [.oauth, .listNumbers, .provisionNumbers, .autoWebhooks, .a2P], supportsOAuth: true),
        ProviderInfo(id: .signalwire, capabilities: [.oauth, .listNumbers, .provisionNumbers, .autoWebhooks], supportsOAuth: true),
        ProviderInfo(id: .telnyx, capabilities: [.oauth, .listNumbers, .provisionNumbers, .autoWebhooks], supportsOAuth: true),
        ProviderInfo(id: .vonage, capabilities: [.oauth, .listNumbers, .provisionNumbers], supportsOAuth: true),
        ProviderInfo(id: .bandwidth, capabilities: [.oauth, .listNumbers, .provisionNumbers, .a2P], supportsOAuth: true),
        ProviderInfo(id: .plivo, capabilities: [.listNumbers, .provisionNumbers], supportsOAuth: false),
        ProviderInfo(id: .asterisk, capabilities: [.sipTrunks], supportsOAuth: false),
        ProviderInfo(id: .freeswitch, capabilities: [.sipTrunks], supportsOAuth: false),
    ]
}

// MARK: - SharedProviderType + Display

extension SharedProviderType {
    var displayName: String {
        switch self {
        case .twilio: return "Twilio"
        case .signalwire: return "SignalWire"
        case .telnyx: return "Telnyx"
        case .vonage: return "Vonage"
        case .bandwidth: return "Bandwidth"
        case .plivo: return "Plivo"
        case .asterisk: return "Asterisk"
        case .freeswitch: return "FreeSWITCH"
        }
    }

    var iconName: String {
        switch self {
        case .twilio: return "phone.fill"
        case .signalwire: return "waveform"
        case .telnyx: return "antenna.radiowaves.left.and.right"
        case .vonage: return "bubble.left.fill"
        case .bandwidth: return "network"
        case .plivo: return "phone.arrow.up.right"
        case .asterisk: return "server.rack"
        case .freeswitch: return "server.rack"
        }
    }
}

// MARK: - ProviderCapability + Display

extension ProviderCapability {
    var shortLabel: String {
        switch self {
        case .oauth: return NSLocalizedString("provider_cap_oauth", comment: "OAuth")
        case .listNumbers: return NSLocalizedString("provider_cap_list_numbers", comment: "List Numbers")
        case .provisionNumbers: return NSLocalizedString("provider_cap_provision", comment: "Provision")
        case .autoWebhooks: return NSLocalizedString("provider_cap_webhooks", comment: "Auto Webhooks")
        case .a2P: return NSLocalizedString("provider_cap_a2p", comment: "A2P")
        case .sipTrunks: return NSLocalizedString("provider_cap_sip", comment: "SIP")
        }
    }
}

// MARK: - ProviderSetupViewModel

/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class ProviderSetupViewModel {
    private let service: ProviderSetupService
    private let hubContext: HubContext

    var providers: [ProviderInfo] = ProviderInfo.all
    var selectedProvider: ProviderInfo?
    var connectionStatus: ProviderStatus = .disconnected
    var isConnecting: Bool = false
    var isTesting: Bool = false
    var testResult: TestConnectionResult?
    var error: String?

    /// Credential fields for API-key based providers (key → value)
    var credentials: [String: String] = [:]

    /// Active OAuth state ID for polling
    var activeOAuthStateId: String?

    /// CSRF state parameter for OAuth deep link validation
    private var oauthCSRFState: String?

    /// OAuth phase tracking
    var oauthPhase: OAuthPhase = .idle

    enum OAuthPhase {
        case idle
        case waitingForBrowser
        case polling
        case complete
        case failed(String)
    }

    init(service: ProviderSetupService, hubContext: HubContext) {
        self.service = service
        self.hubContext = hubContext
    }

    var hubId: String? { hubContext.activeHubId }

    // MARK: - Actions

    func selectProvider(_ info: ProviderInfo) {
        selectedProvider = info
        connectionStatus = .disconnected
        error = nil
        testResult = nil
        oauthPhase = .idle
        credentials = [:]
        activeOAuthStateId = nil
        oauthCSRFState = nil
    }

    /// Start OAuth flow — returns the authorization URL to open in ASWebAuthenticationSession.
    /// Generates a random CSRF state token for deep link validation.
    func startOAuth() async throws -> URL {
        guard let provider = selectedProvider else {
            throw APIError.requestFailed(statusCode: 400, body: "No provider selected")
        }
        isConnecting = true
        error = nil
        oauthPhase = .waitingForBrowser
        defer { isConnecting = false }

        // Generate CSRF state to prevent forged deep link callbacks
        let csrfState = UUID().uuidString
        oauthCSRFState = csrfState

        let redirectURL = "llamenos://oauth/callback?csrf_state=\(csrfState)"
        let response = try await service.startOAuth(
            provider: provider.id,
            redirectURL: redirectURL,
            hubId: hubId
        )
        activeOAuthStateId = response.stateID
        oauthPhase = .polling

        guard let url = URL(string: response.authURL) else {
            throw APIError.invalidURL(response.authURL)
        }
        return url
    }

    /// Poll OAuth state until complete/failed/expired.
    func pollOAuthStatus() async {
        guard let stateId = activeOAuthStateId else { return }

        for _ in 0..<30 {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            do {
                let state = try await service.getOAuthStatus(state: stateId)
                switch state.status {
                case .tokenExchanged, .callbackReceived:
                    oauthPhase = .complete
                    connectionStatus = .connected
                    return
                case .failed:
                    oauthPhase = .failed(state.error ?? NSLocalizedString("provider_oauth_failed", comment: "OAuth failed"))
                    return
                case .expired:
                    oauthPhase = .failed(NSLocalizedString("provider_oauth_expired", comment: "OAuth session expired"))
                    return
                case .pending:
                    continue
                }
            } catch {
                // Network hiccup — keep polling
            }
        }
        oauthPhase = .failed(NSLocalizedString("provider_oauth_timeout", comment: "OAuth timed out"))
    }

    /// Handle OAuth callback from deep link.
    /// Validates the CSRF state parameter to prevent forged callbacks.
    func handleOAuthCallback(success: Bool, state: String? = nil, errorMessage: String? = nil) {
        // Validate CSRF state — reject if it doesn't match
        if let expectedState = oauthCSRFState {
            guard let state, state == expectedState else {
                oauthPhase = .failed(NSLocalizedString("provider_oauth_state_mismatch", comment: "OAuth state mismatch — callback rejected"))
                oauthCSRFState = nil
                return
            }
        }
        oauthCSRFState = nil

        if success {
            oauthPhase = .complete
            connectionStatus = .connected
        } else {
            oauthPhase = .failed(errorMessage ?? NSLocalizedString("provider_oauth_failed", comment: "OAuth failed"))
        }
    }

    /// Configure provider with manual API credentials.
    /// Clears credential values from memory after submission regardless of outcome.
    func configureWithCredentials() async {
        guard let provider = selectedProvider else { return }
        isConnecting = true
        error = nil
        defer {
            isConnecting = false
            // Clear sensitive credential values from memory after sending to server
            for key in credentials.keys {
                credentials[key] = ""
            }
            credentials.removeAll()
        }
        do {
            try await service.configureProvider(provider: provider.id, credentials: credentials, hubId: hubId)
            connectionStatus = .connected
        } catch {
            self.error = error.localizedDescription
            connectionStatus = .error
        }
    }

    /// Test the current provider connection.
    func testConnection() async {
        guard let provider = selectedProvider else { return }
        isTesting = true
        error = nil
        testResult = nil
        defer { isTesting = false }
        do {
            let result = try await service.testProvider(provider: provider.id, hubId: hubId)
            testResult = result
            if result.connected {
                connectionStatus = .connected
            } else {
                connectionStatus = .error
                error = result.error
            }
        } catch {
            self.error = error.localizedDescription
            connectionStatus = .error
        }
    }

    /// Reload status for the current provider from the server.
    func loadStatus() async {
        guard let provider = selectedProvider else { return }
        do {
            let status = try await service.getProviderStatus(provider: provider.id, hubId: hubId)
            connectionStatus = status.status
        } catch {
            // Silently swallow — status display is best-effort
        }
    }

    // MARK: - Credential field helpers

    /// Returns credential field definitions for the selected provider.
    var credentialFields: [(key: String, label: String, isSecret: Bool)] {
        guard let provider = selectedProvider else { return [] }
        switch provider.id {
        case .twilio:
            return [
                ("accountSid", NSLocalizedString("provider_field_account_sid", comment: "Account SID"), false),
                ("authToken", NSLocalizedString("provider_field_auth_token", comment: "Auth Token"), true),
            ]
        case .signalwire:
            return [
                ("projectId", NSLocalizedString("provider_field_project_id", comment: "Project ID"), false),
                ("apiToken", NSLocalizedString("provider_field_api_token", comment: "API Token"), true),
                ("spaceUrl", NSLocalizedString("provider_field_space_url", comment: "Space URL"), false),
            ]
        case .telnyx:
            return [
                ("apiKey", NSLocalizedString("provider_field_api_key", comment: "API Key"), true),
            ]
        case .vonage:
            return [
                ("apiKey", NSLocalizedString("provider_field_api_key", comment: "API Key"), false),
                ("apiSecret", NSLocalizedString("provider_field_api_secret", comment: "API Secret"), true),
            ]
        case .bandwidth:
            return [
                ("accountId", NSLocalizedString("provider_field_account_id", comment: "Account ID"), false),
                ("apiKey", NSLocalizedString("provider_field_api_key", comment: "API Key"), true),
                ("apiSecret", NSLocalizedString("provider_field_api_secret", comment: "API Secret"), true),
            ]
        case .plivo:
            return [
                ("authId", NSLocalizedString("provider_field_auth_id", comment: "Auth ID"), false),
                ("authToken", NSLocalizedString("provider_field_auth_token", comment: "Auth Token"), true),
            ]
        case .asterisk, .freeswitch:
            return [
                ("ariUrl", NSLocalizedString("provider_field_ari_url", comment: "ARI URL"), false),
                ("ariUsername", NSLocalizedString("provider_field_ari_username", comment: "ARI Username"), false),
                ("ariPassword", NSLocalizedString("provider_field_ari_password", comment: "ARI Password"), true),
            ]
        }
    }

    var credentialsComplete: Bool {
        credentialFields.allSatisfy { field in
            !(credentials[field.key] ?? "").isEmpty
        }
    }
}
