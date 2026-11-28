import SwiftUI

// MARK: - AppBlast
// Client-only: generated `Blast` is not decoded directly because it types the list
// pagination fields as `Double` and carries no UI helpers. `content` is the wire
// shape the server answers for every blast (#2572): `{ body, mediaUrl? }`, or a
// record of those keyed by language code.

/// One message of a blast (`singleBlastContentSchema`).
struct AppBlastMessage: Codable, Sendable {
    let body: String
    let mediaUrl: String?
}

/// Blast content on the wire: a single message, or one message per language.
enum AppBlastContent: Codable, Sendable {
    case single(AppBlastMessage)
    case multi([String: AppBlastMessage])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let single = try? container.decode(AppBlastMessage.self) {
            self = .single(single)
        } else {
            self = .multi(try container.decode([String: AppBlastMessage].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .single(let message): try container.encode(message)
        case .multi(let byLanguage): try container.encode(byLanguage)
        }
    }

    /// First non-empty message body; languages are tried in code order.
    var firstBody: String? {
        switch self {
        case .single(let message):
            return message.body.isEmpty ? nil : message.body
        case .multi(let byLanguage):
            return byLanguage.sorted { $0.key < $1.key }.map(\.value.body).first { !$0.isEmpty }
        }
    }
}

/// Client-side blast model with UI-specific fields and computed properties.
/// Named `AppBlast` to avoid conflict with generated `Blast` from protocol codegen.
struct AppBlast: Identifiable, Codable, Sendable {
    let id: String
    let name: String
    let content: AppBlastContent
    let targetChannels: [String]
    let targetTags: [String]
    let targetLanguages: [String]
    let status: String
    let createdAt: String
    let sentAt: String?
    let scheduledAt: String?

    var statusEnum: SharedBlastListResponseStatus { SharedBlastListResponseStatus(rawValue: status) ?? .draft }

    var messagePreview: String {
        content.firstBody ?? NSLocalizedString("blast_no_content", comment: "No message content")
    }
}

/// `{ blast }` — what create, send, schedule and cancel all answer (`blastEnvelopeResponseSchema`).
struct AppBlastEnvelope: Codable, Sendable {
    let blast: AppBlast
}

/// Client-side API response for the blast list.
/// Named `AppBlastsListResponse` to avoid conflict with generated `BlastListResponse`
/// which uses `Double` for pagination fields.
struct AppBlastsListResponse: Codable, Sendable {
    let blasts: [AppBlast]
    let total: Int
}

// MARK: - SharedBlastListResponseStatus UI Extensions
// Generated `SharedBlastListResponseStatus` has: draft, sent, scheduled, cancelled, sending.
// We add UI display properties (icon, color, displayName) as extensions.

extension SharedBlastListResponseStatus: CaseIterable {
    public static var allCases: [SharedBlastListResponseStatus] {
        [.draft, .sent, .scheduled, .cancelled, .sending]
    }

    var icon: String {
        switch self {
        case .draft: return "pencil"
        case .sent: return "paperplane.fill"
        case .scheduled: return "clock.fill"
        case .cancelled: return "xmark.circle.fill"
        case .sending: return "arrow.up.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .draft: return .statusWarning
        case .sent: return .statusActive
        case .scheduled: return .brandAccent
        case .cancelled: return .brandDestructive
        case .sending: return .brandPrimary
        }
    }

    var displayName: String {
        switch self {
        case .draft: return NSLocalizedString("blast_status_draft", comment: "Draft")
        case .sent: return NSLocalizedString("blast_status_sent", comment: "Sent")
        case .scheduled: return NSLocalizedString("blast_status_scheduled", comment: "Scheduled")
        case .cancelled: return NSLocalizedString("blast_status_cancelled", comment: "Cancelled")
        case .sending: return NSLocalizedString("blast_status_sending", comment: "Sending")
        }
    }
}

// MARK: - Create Blast Request

/// Body of `POST /api/hubs/:hubId/blasts` (`createBlastBodySchema`).
struct CreateBlastRequest: Codable, Sendable {
    let name: String
    let content: AppBlastMessage
    let channels: [String]
}

// MARK: - Schedule Blast Request

struct ScheduleBlastRequest: Codable, Sendable {
    let scheduledAt: String
}

// MARK: - Subscriber Stats
// Generated `SubscriberStatsResponse` uses `[String: Double]` for byChannel/byStatus
// with `Double` total — different shape from this flat Int model.

struct BlastSubscriberStats: Codable, Sendable {
    let total: Int
    let active: Int
    let paused: Int
    let unsubscribed: Int
}
