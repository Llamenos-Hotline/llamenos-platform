import SwiftUI

// MARK: - Contact summary UI extensions
// Contact lists decode to generated `ContactTimelineListResponse` whose
// elements are generated `SharedContactTimelineListResponseContact`
// (packages/protocol/schemas/contacts.ts — contactTimelineSummarySchema).
// Only the display helpers below are client-side.

extension SharedContactTimelineListResponseContact: Identifiable {
    public var id: String { contactHash }

    var displayIdentifier: String {
        if let last4 { return "***\(last4)" }
        return String(contactHash.prefix(8)) + "..."
    }

    var totalInteractions: Int {
        Int(callCount + conversationCount + noteCount + reportCount)
    }

    /// Whether `query` names this contact. The server holds contacts only as
    /// hashes (plus the last four digits of a phone number), so those are the
    /// only things there is to search. Leading `*` is ignored so the displayed
    /// form (`***1234`) finds the same contact as the digits.
    func matches(_ query: String) -> Bool {
        let needle = query
            .filter { $0 != "*" }
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !needle.isEmpty else { return true }
        if let last4, last4.lowercased().contains(needle) { return true }
        return contactHash.lowercased().contains(needle)
    }
}

// MARK: - Timeline Event
// Client-only: generated `ContactTimelineDetailResponse` uses `[[String: JSONAny]]`
// for unstructured event data. This client model has typed fields.

struct ContactTimelineEvent: Identifiable, Codable, Sendable {
    let id: String
    let type: String
    let timestamp: String
    let summary: String?
    let status: String?
    let duration: Int?

    var eventType: ContactEventType { ContactEventType(rawValue: type) ?? .call }
}

/// `GET /api/contacts/:hash` — the unified timeline (PROTOCOL §4.29). The server returns the
/// contact's notes and conversations as separate lists (`contactTimelineDetailResponseSchema`);
/// this folds them into one newest-first event list. Note content is encrypted, so note events
/// carry no summary.
struct ContactTimelineResponse: Decodable, Sendable {
    let events: [ContactTimelineEvent]
    var total: Int { events.count }

    private enum CodingKeys: String, CodingKey { case notes, conversations }

    private struct NoteRow: Decodable {
        let id: String
        let createdAt: String
    }

    private struct ConversationRow: Decodable {
        let id: String
        let channelType: String
        let status: String
        let createdAt: String
        let lastMessageAt: String?
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let notes = try container.decode([NoteRow].self, forKey: .notes)
        let conversations = try container.decode([ConversationRow].self, forKey: .conversations)

        let noteEvents = notes.map {
            ContactTimelineEvent(
                id: $0.id, type: ContactEventType.note.rawValue, timestamp: $0.createdAt,
                summary: nil, status: nil, duration: nil
            )
        }
        let conversationEvents = conversations.map {
            ContactTimelineEvent(
                id: $0.id, type: ContactEventType.conversation.rawValue,
                timestamp: $0.lastMessageAt ?? $0.createdAt,
                summary: $0.channelType, status: $0.status, duration: nil
            )
        }
        // ISO-8601 UTC timestamps from the same serializer sort correctly as strings.
        events = (noteEvents + conversationEvents).sorted { $0.timestamp > $1.timestamp }
    }
}

// MARK: - Contact Detail
// SKIPPED (#1329): no server endpoint returns this shape. GET /api/contacts/:hash
// returns the timeline detail ({notes, conversations} — generated
// `ContactTimelineDetailResponse`), and the CMS directory lives at
// /api/directory/:id with the encrypted `Contact` shape. This model and its
// screen are kept as-is pending a product decision on which wire shape the
// contact detail screen should consume; do not extend.

/// Full contact profile including linked cases and identifiers.
struct ContactDetail: Codable, Sendable {
    let contactHash: String
    let last4: String?
    let firstSeen: String
    let lastSeen: String
    let callCount: Int
    let conversationCount: Int
    let noteCount: Int
    let reportCount: Int
    let contactType: String?
    let linkedCases: [ContactLinkedCase]?
    let identifiers: [ContactIdentifier]?

    var displayIdentifier: String {
        if let last4 { return "***\(last4)" }
        return String(contactHash.prefix(8)) + "..."
    }
}

/// A case linked to a contact.
struct ContactLinkedCase: Codable, Identifiable, Sendable {
    let id: String
    let caseNumber: String?
    let entityTypeId: String
    let statusHash: String
    let role: String?
    let createdAt: String
}

/// An identifier associated with a contact (phone, email, etc).
struct ContactIdentifier: Codable, Identifiable, Sendable {
    var id: String { type + ":" + (value ?? hash) }
    let type: String
    let hash: String
    let value: String?
    let addedAt: String?
}

extension ContactDetail {
    /// The profile of a contact the list already returned, with the note and
    /// conversation counts taken from the activity `GET /api/contacts/:hash`
    /// returned for it. The server holds no contact type, linked cases or
    /// identifiers for a hashed contact, so those stay absent rather than
    /// being invented.
    init(summary: SharedContactTimelineListResponseContact, activity: ContactTimelineDetailResponse) {
        self.init(
            contactHash: summary.contactHash,
            last4: summary.last4,
            firstSeen: summary.firstSeen,
            lastSeen: summary.lastSeen,
            callCount: Int(summary.callCount),
            conversationCount: activity.conversations.count,
            noteCount: activity.notes.count,
            reportCount: Int(summary.reportCount),
            contactType: nil,
            linkedCases: nil,
            identifiers: nil
        )
    }
}

// MARK: - Contact Relationship
// Client-only: generated `ContactRelationship` has different field structure.

/// A relationship between two contacts.
struct AppContactRelationship: Codable, Identifiable, Sendable {
    var id: String { relatedContactHash + ":" + relationshipType }
    let relatedContactHash: String
    let relatedLast4: String?
    let relationshipType: String
    let createdAt: String?

    var relatedDisplayIdentifier: String {
        if let relatedLast4 { return "***\(relatedLast4)" }
        return String(relatedContactHash.prefix(8)) + "..."
    }
}

struct AppContactRelationshipsResponse: Codable, Sendable {
    let relationships: [AppContactRelationship]
}

// MARK: - Event Type
// Client-only: UI display properties (icon, color, displayName).

enum ContactEventType: String, CaseIterable, Sendable {
    case call
    case conversation
    case note
    case report

    var icon: String {
        switch self {
        case .call: return "phone.fill"
        case .conversation: return "message.fill"
        case .note: return "doc.text.fill"
        case .report: return "exclamationmark.triangle.fill"
        }
    }

    var color: Color {
        switch self {
        case .call: return .brandPrimary
        case .conversation: return .statusActive
        case .note: return .brandDarkTeal
        case .report: return .brandAccent
        }
    }

    var displayName: String {
        switch self {
        case .call: return NSLocalizedString("event_type_call", comment: "Call")
        case .conversation: return NSLocalizedString("event_type_conversation", comment: "Conversation")
        case .note: return NSLocalizedString("event_type_note", comment: "Note")
        case .report: return NSLocalizedString("event_type_report", comment: "Report")
        }
    }
}
