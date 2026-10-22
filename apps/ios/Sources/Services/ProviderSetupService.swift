import Foundation

// MARK: - TestConnectionResult

struct TestConnectionResult: Decodable {
    let connected: Bool
    let latencyMs: Double?
    let accountName: String?
    let error: String?
    let errorType: String?

    enum CodingKeys: String, CodingKey {
        case connected, latencyMs, accountName, error, errorType
    }
}

// MARK: - WebhookConfigureRequest

private struct WebhookConfigureRequest: Encodable {
    let provider: String
    let numberId: String
    let enableSms: Bool
    let hubId: String?
}

// MARK: - TestConnectionRequest

private struct TestConnectionRequest: Encodable {
    let provider: String
    let hubId: String?
}

// MARK: - SignalVerifyRequest

private struct SignalVerifyRequest: Encodable {
    let registrationId: String
    let code: String
}

// MARK: - SignalStatusQuery

private struct A2PBrandRequest: Encodable {
    let brandInfo: [String: String]
    let providerType: String
    let hubId: String?
}

// MARK: - A2PSkipRequest

private struct A2PSkipRequest: Encodable {
    let providerType: String
    let hubId: String?
}

// MARK: - NumberListResponse

struct NumberListResponse: Decodable {
    let numbers: [OwnedNumber]
}

// MARK: - AvailableNumberListResponse

struct AvailableNumberListResponse: Decodable {
    let numbers: [AvailableNumber]
}

// MARK: - ProviderSetupService

/// Service wrapping all `/provider-setup` API endpoints.
final class ProviderSetupService {
    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    // MARK: - OAuth

    func startOAuth(provider: SharedProviderType, redirectURL: String, hubId: String?) async throws -> StartOAuthResponse {
        let body = StartOAuthRequest(hubID: hubId, provider: provider, redirectURL: redirectURL)
        return try await api.request(method: "POST", path: "/api/provider-setup/oauth/start", body: body)
    }

    func getOAuthStatus(state: String) async throws -> OauthFlowState {
        return try await api.request(
            method: "GET",
            path: "/api/provider-setup/oauth/status/\(state.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? state)"
        )
    }

    // MARK: - Configuration

    func configureProvider(provider: SharedProviderType, credentials: [String: String], hubId: String?) async throws {
        let body = ConfigureProviderRequest(credentials: credentials, hubID: hubId, phoneNumber: nil, provider: provider)
        let _: EmptyResponse = try await api.request(method: "POST", path: "/api/provider-setup/configure", body: body)
    }

    func testProvider(provider: SharedProviderType, hubId: String?) async throws -> TestConnectionResult {
        let body = TestConnectionRequest(provider: provider.rawValue, hubId: hubId)
        return try await api.request(method: "POST", path: "/api/provider-setup/test", body: body)
    }

    func getProviderStatus(provider: SharedProviderType, hubId: String?) async throws -> ProviderStatusResponse {
        var path = "/api/provider-setup/status/\(provider.rawValue)"
        if let hubId {
            path += "?hubId=\(hubId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? hubId)"
        }
        return try await api.request(method: "GET", path: path)
    }

    // MARK: - Phone Numbers

    func listPhoneNumbers(provider: SharedProviderType, hubId: String?) async throws -> [OwnedNumber] {
        var qs = "provider=\(provider.rawValue)"
        if let hubId { qs += "&hubId=\(hubId)" }
        let response: NumberListResponse = try await api.request(method: "GET", path: "/api/provider-setup/phone-numbers?\(qs)")
        return response.numbers
    }

    func searchPhoneNumbers(query: NumberSearchQuery) async throws -> [AvailableNumber] {
        let response: AvailableNumberListResponse = try await api.request(
            method: "POST",
            path: "/api/provider-setup/phone-numbers/search",
            body: query
        )
        return response.numbers
    }

    func provisionPhoneNumber(request: NumberProvisionRequest) async throws -> OwnedNumber {
        return try await api.request(method: "POST", path: "/api/provider-setup/phone-numbers/provision", body: request)
    }

    // MARK: - Webhooks

    func configureWebhooks(provider: SharedProviderType, numberId: String, enableSms: Bool, hubId: String?) async throws -> WebhookConfigState {
        let body = WebhookConfigureRequest(
            provider: provider.rawValue,
            numberId: numberId,
            enableSms: enableSms,
            hubId: hubId
        )
        return try await api.request(method: "POST", path: "/api/provider-setup/configure-webhooks", body: body)
    }

    // MARK: - Signal

    func startSignalRegistration(body: SignalRegisterBody, hubId: String?) async throws -> SignalRegistrationState {
        // Pass hubId as query param; body already includes bridge info
        var path = "/api/provider-setup/signal/register"
        if let hubId { path += "?hubId=\(hubId)" }
        return try await api.request(method: "POST", path: path, body: body)
    }

    func getSignalStatus(hubId: String?) async throws -> SignalRegistrationState {
        var path = "/api/provider-setup/signal/status"
        if let hubId { path += "?hubId=\(hubId)" }
        return try await api.request(method: "GET", path: path)
    }

    func verifySignalCode(registrationId: String, code: String) async throws -> SignalRegistrationState {
        let body = SignalVerifyRequest(registrationId: registrationId, code: code)
        return try await api.request(method: "POST", path: "/api/provider-setup/signal/verify", body: body)
    }

    func unregisterSignal(registrationId: String, hubId: String?) async throws {
        var qs = "registrationId=\(registrationId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? registrationId)"
        if let hubId { qs += "&hubId=\(hubId)" }
        let _: EmptyResponse = try await api.request(method: "DELETE", path: "/api/provider-setup/signal/unregister?\(qs)")
    }

    // MARK: - A2P

    func submitA2PBrand(brandInfo: [String: String], providerType: SharedProviderType, hubId: String?) async throws -> A2PRegistrationState {
        let body = A2PBrandRequest(brandInfo: brandInfo, providerType: providerType.rawValue, hubId: hubId)
        return try await api.request(method: "POST", path: "/api/provider-setup/a2p/brand", body: body)
    }

    func getA2PStatus(hubId: String?) async throws -> A2PRegistrationState {
        var path = "/api/provider-setup/a2p/status"
        if let hubId { path += "?hubId=\(hubId)" }
        return try await api.request(method: "GET", path: path)
    }

    func skipA2P(providerType: SharedProviderType, hubId: String?) async throws {
        let body = A2PSkipRequest(providerType: providerType.rawValue, hubId: hubId)
        let _: EmptyResponse = try await api.request(method: "POST", path: "/api/provider-setup/a2p/skip", body: body)
    }
}
