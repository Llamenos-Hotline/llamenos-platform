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

struct ContactTimelineResponse: Codable, Sendable {
    let events: [ContactTimelineEvent]
    let total: Int
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

/// SKIPPED (#1329): kept with `ContactDetail` — no server endpoint returns
/// this wrapper shape today.
struct ContactDetailResponse: Codable, Sendable {
    let contact: ContactDetail
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

// MARK: - Contact Search Response

// Contact list and search responses both decode to generated
// `ContactTimelineListResponse`.

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
