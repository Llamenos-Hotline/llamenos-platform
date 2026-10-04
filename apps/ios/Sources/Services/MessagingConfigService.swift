import Foundation

enum MessagingChannelType: String, Codable, CaseIterable, Identifiable {
    case sms, whatsapp, signal, telegram, rcs
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .sms: return NSLocalizedString("channels_sms_title", comment: "SMS Channel")
        case .whatsapp: return NSLocalizedString("channels_whatsapp_title", comment: "WhatsApp Channel")
        case .signal: return NSLocalizedString("signal_title", comment: "Signal Channel")
        case .telegram: return NSLocalizedString("channels_telegram_title", comment: "Telegram Channel")
        case .rcs: return NSLocalizedString("rcs_title", comment: "RCS Channel")
        }
    }

    var iconName: String {
        switch self {
        case .sms: return "phone.fill"
        case .whatsapp: return "message.fill"
        case .signal: return "shield.fill"
        case .telegram: return "paperplane.fill"
        case .rcs: return "bubble.left.and.bubble.right.fill"
        }
    }
}

struct SMSConfigResponse: Codable {
    var enabled: Bool
    var autoResponse: String?
    var afterHoursResponse: String?
}

struct WhatsAppConfigResponse: Codable {
    var integrationMode: String
    var phoneNumberId: String?
    var businessAccountId: String?
    var accessToken: String?
    var verifyToken: String?
    var appSecret: String?
    var autoResponse: String?
    var afterHoursResponse: String?
}

struct SignalConfigResponse: Codable {
    var bridgeUrl: String
    var bridgeApiKey: String
    var webhookSecret: String
    var registeredNumber: String
    var trustMode: String?
    var autoResponse: String?
    var afterHoursResponse: String?
}

struct TelegramConfigResponse: Codable {
    var enabled: Bool
    var botToken: String
    var webhookSecret: String?
    var botUsername: String?
    var autoResponse: String?
    var afterHoursResponse: String?
}

struct RCSConfigResponse: Codable {
    var agentId: String
    var serviceAccountKey: String
    var webhookSecret: String?
    var fallbackToSms: Bool
    var autoResponse: String?
    var afterHoursResponse: String?
}

struct MessagingConfigResponse: Codable {
    var enabledChannels: [String]
    var sms: SMSConfigResponse?
    var whatsapp: WhatsAppConfigResponse?
    var signal: SignalConfigResponse?
    var rcs: RCSConfigResponse?
    var telegram: TelegramConfigResponse?
    var autoAssign: Bool
    var inactivityTimeout: Int
    var maxConcurrentPerUser: Int
    var preferSignalDelivery: Bool?
    var smsContentMode: String?
}

struct AppConnectionTestResponse: Codable {
    let connected: Bool
}

// A2P registration state decodes to the generated `A2PRegistrationState`
// (packages/protocol/schemas/provider-setup/a2p-registration.ts). The old
// hand-written shape carried `error`/`brandSidMasked`/`campaignSidMasked`,
// which the wire has never included.

@Observable
final class MessagingConfigService {
    private let api: APIService

    var config: MessagingConfigResponse?
    var a2pRegistration: A2PRegistrationState?
    var isLoading = false
    var error: String?

    init(api: APIService) {
        self.api = api
    }

    func loadConfig() async {
        isLoading = true
        error = nil
        do {
            config = try await api.request(method: "GET", path: "/settings/messaging")
            isLoading = false
        } catch {
            self.error = error.localizedDescription
            isLoading = false
        }
    }

    func updateConfig(_ updates: [String: Any]) async throws {
        let rawBody = try JSONSerialization.data(withJSONObject: updates)
        config = try await api.request(method: "PATCH", path: "/settings/messaging", rawBody: rawBody)
    }

    func testChannel(_ channel: String) async throws -> Bool {
        let rawBody = try JSONSerialization.data(withJSONObject: ["channel": channel])
        let response: AppConnectionTestResponse = try await api.request(
            method: "POST", path: "/settings/messaging/test", rawBody: rawBody
        )
        return response.connected
    }

    func loadA2pStatus(hubId: String) async {
        do {
            a2pRegistration = try await api.request(
                method: "GET", path: "/provider-setup/a2p/status?hubId=\(hubId)"
            )
        } catch {
            a2pRegistration = nil
        }
    }

    func submitBrand(hubId: String, brandInfo: [String: Any]) async throws -> A2PRegistrationState {
        let rawBody = try JSONSerialization.data(withJSONObject: [
            "hubId": hubId,
            "brandInfo": brandInfo,
        ])
        return try await api.request(method: "POST", path: "/provider-setup/a2p/brand", rawBody: rawBody)
    }

    func submitCampaign(registrationId: String, hubId: String, campaignInfo: [String: Any]) async throws -> A2PRegistrationState {
        let rawBody = try JSONSerialization.data(withJSONObject: [
            "registrationId": registrationId,
            "hubId": hubId,
            "campaignInfo": campaignInfo,
        ])
        return try await api.request(method: "POST", path: "/provider-setup/a2p/campaign", rawBody: rawBody)
    }

    func skipA2p(hubId: String) async throws -> A2PRegistrationState {
        let rawBody = try JSONSerialization.data(withJSONObject: ["hubId": hubId])
        return try await api.request(method: "POST", path: "/provider-setup/a2p/skip", rawBody: rawBody)
    }
}
