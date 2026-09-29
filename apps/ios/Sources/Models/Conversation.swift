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

// MARK: - ConversationMessage
// Client-only: generated `Message` uses `MessageDirection` enum and
// `MessageReaderEnvelope` instead of `RecipientEnvelope`.

/// An encrypted message within a conversation, matching the wire format.
struct ConversationMessage: Codable, Identifiable, Sendable {
    let id: String
    let conversationId: String
    let direction: String
    let encryptedContent: String
    let recipientEnvelopes: [RecipientEnvelope]
    let channelType: String
    let createdAt: String
    let readAt: String?

    /// Whether the message has been read.
    var isRead: Bool { readAt != nil }

    /// Whether this is an inbound message.
    var isInbound: Bool { direction == "inbound" }

    /// Parsed channel type.
    var channel: ClientChannelType {
        ClientChannelType(rawValue: channelType) ?? .sms
    }
}

// MARK: - ConversationMessagesResponse

/// API response wrapper for a conversation's messages.
struct ConversationMessagesResponse: Codable, Sendable {
    let messages: [ConversationMessage]
}

// MARK: - SendMessageRequest

/// Request body for `POST /api/conversations/:id/messages`.
struct SendMessageRequest: Encodable, Sendable {
    let encryptedContent: String
    let recipientEnvelopes: [RecipientEnvelope]
}

// MARK: - MarkReadResponse

/// Response from `POST /api/conversations/:id/read`.
struct MarkReadResponse: Codable, Sendable {
    let ok: Bool
}
