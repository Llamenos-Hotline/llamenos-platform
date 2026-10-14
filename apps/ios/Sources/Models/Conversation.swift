import Foundation

// MARK: - ClientChannelType
// Client-only: UI display properties (iconName, displayName, badgeColorName).
// Generated `ChannelType` enum has same cases but no UI properties.

/// Messaging channel types supported by the platform (client-side enum with UI properties).
/// Named `ClientChannelType` to avoid conflict with generated `ChannelType` from protocol.
enum ClientChannelType: String, Codable, Sendable, CaseIterable {
    case sms
    case whatsapp
    case signal

    /// SF Symbol icon name for this channel.
    var iconName: String {
        switch self {
        case .sms: return "message.fill"
        case .whatsapp: return "bubble.left.and.text.bubble.right.fill"
        case .signal: return "lock.shield.fill"
        }
    }

    /// Human-readable display name.
    var displayName: String {
        switch self {
        case .sms: return "SMS"
        case .whatsapp: return "WhatsApp"
        case .signal: return "Signal"
        }
    }

    /// Tint color for the channel badge.
    var badgeColorName: String {
        switch self {
        case .sms: return "blue"
        case .whatsapp: return "green"
        case .signal: return "indigo"
        }
    }
}

// MARK: - SharedReportResponseStatus UI Extensions
// Generated `SharedReportResponseStatus` has: active, closed, waiting.
// We add displayName as an extension instead of maintaining a separate enum.

typealias ConversationStatus = SharedReportResponseStatus

extension SharedReportResponseStatus: CaseIterable {
    public static var allCases: [SharedReportResponseStatus] {
        [.active, .closed, .waiting]
    }

    var displayName: String {
        switch self {
        case .active: return NSLocalizedString("conversation_status_active", comment: "Active")
        case .closed: return NSLocalizedString("conversation_status_closed", comment: "Closed")
        case .waiting: return NSLocalizedString("conversation_status_waiting", comment: "Waiting")
        }
    }
}

// MARK: - ConversationListResponseConversation UI Extensions
// The list decodes into the generated `ConversationListResponse`; these are display
// helpers only. There is no unread count on the wire (`messageCount` is the total).

extension ConversationListResponseConversation: Identifiable {
    /// Parsed channel type enum.
    var channel: ClientChannelType {
        ClientChannelType(rawValue: channelType) ?? .sms
    }

    /// Conversation status; the server stores `waiting` until someone claims it.
    var conversationStatus: ConversationStatus {
        status ?? .waiting
    }

    /// Truncated contact hash for display.
    var contactDisplayHash: String {
        guard contactIdentifierHash.count > 12 else { return contactIdentifierHash }
        return "\(contactIdentifierHash.prefix(6))...\(contactIdentifierHash.suffix(4))"
    }

    /// Parsed last message date.
    var lastMessageDate: Date? {
        guard let str = lastMessageAt else { return nil }
        return DateFormatting.parseISO(str)
    }

    /// Parsed creation date.
    var createdDate: Date? {
        DateFormatting.parseISO(createdAt)
    }

    /// Relative time string for the last message.
    var lastMessageRelativeTime: String {
        guard let date = lastMessageDate else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
