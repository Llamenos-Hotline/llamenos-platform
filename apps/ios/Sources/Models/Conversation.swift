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

// MARK: - ConversationResponse UI Extensions
// The generated `ConversationResponse` (from `conversationResponseSchema`) IS the
// wire shape — the conversations drizzle row returned verbatim. #1294: the
// hand-written `AppConversation` that used to sit here required `contactHash`
// (renamed via CodingKeys) and tolerated an `unreadCount` the server has never
// sent; every rename layer is a drift opportunity, so the model is the generated
// type and only UI conveniences live in this extension. There is no per-user
// unread count on the wire at all, so nothing here invents one.

extension ConversationResponse: Identifiable {}

extension ConversationResponse {
    /// Parsed channel type enum.
    var channel: ClientChannelType {
        ClientChannelType(rawValue: channelType) ?? .sms
    }

    /// Maps the generated schema-optional `status` (`SharedReportResponseStatus?`)
    /// to the non-optional `ConversationStatus` the views switch on, defaulting a
    /// missing value to `.active` for display.
    var conversationStatus: ConversationStatus {
        status ?? .active
    }

    /// Truncated contact hash for display.
    var contactDisplayHash: String {
        guard contactIdentifierHash.count > 12 else { return contactIdentifierHash }
        return "\(contactIdentifierHash.prefix(6))...\(contactIdentifierHash.suffix(4))"
    }

    /// Parsed last message date.
    var lastMessageDate: Date? {
        guard let lastMessageAt else { return nil }
        return DateFormatting.parseISO(lastMessageAt)
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
///
/// The authoritative shape is the `messages` row the server returns verbatim —
/// `addMessage`'s 201 and `listMessages` both `c.json` the raw drizzle row
/// (apps/worker/db/schema/conversations.ts) — and `messageResponseSchema` in
/// packages/protocol/schemas/conversations.ts describes it.
///
/// #1633: this declared a required `recipientEnvelopes` and a required
/// `channelType`. The server sends neither: the column is `reader_envelopes`
/// → `readerEnvelopes`, and a message row has no channel at all (the channel
/// belongs to the conversation). Both were `keyNotFound` on decode.
///
/// That was unreachable until the encoder fix in this change: while iOS
/// snake_cased its request keys the send 400'd first, so the response was never
/// decoded. Once the send validated, the message was stored and delivered and
/// *then* the decode threw — telling the volunteer a delivered reply had failed
/// and inviting a retry that double-sends to a caller on a crisis line. A
/// renamed request key obliges you to check the response model on the same
/// endpoint; `APIServiceResponseDecodingTests` now pins it.
struct ConversationMessage: Codable, Identifiable, Sendable {
    let id: String
    let conversationId: String
    let direction: String
    let encryptedContent: String
    let readerEnvelopes: [RecipientEnvelope]
    let createdAt: String
    let readAt: String?

    /// Whether the message has been read.
    var isRead: Bool { readAt != nil }

    /// Whether this is an inbound message.
    var isInbound: Bool { direction == "inbound" }

    // No `channel` accessor: a message row carries no channel. The channel belongs to
    // the conversation (`ConversationResponse.channel`), which is what the views already use.
}

// MARK: - ConversationsListResponse

/// API response wrapper for the conversations list.
///
/// Hand-written envelope around the GENERATED element type, because the server's
/// list envelope is not the generated `ConversationListResponse`:
/// `GET /api/conversations` returns `{conversations, total}` for read-all users
/// and `{conversations, assignedCount, waitingCount, claimableChannels}` for
/// everyone else (apps/worker/routes/conversations.ts) — neither carries the
/// `page`/`limit`/`total` triple `conversationListResponseSchema` requires.
/// Only the element type was the drifted half, so only the element type is generated.
struct ConversationsListResponse: Codable, Sendable {
    let conversations: [ConversationResponse]
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
    /// #1633: `sendMessageBodySchema` (packages/protocol/schemas/conversations.ts)
    /// names this `readerEnvelopes`. It was `recipientEnvelopes` here, a key the
    /// schema does not declare — and since it is `.optional()`, one the validator
    /// dropped instead of rejecting.
    let readerEnvelopes: [RecipientEnvelope]
}

// MARK: - MarkReadResponse

/// Response from `POST /api/conversations/:id/read`.
struct MarkReadResponse: Codable, Sendable {
    let ok: Bool
}
