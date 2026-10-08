import Foundation

// MARK: - AppCaseEvent
// Client-only: generated `EventListResponseEvent`/`ProtocolEvent` use `BlindIndex` enum
// for blind indexes, `Precision` enum for locationPrecision, `Double` for counts,
// and non-optional fields. This client model uses raw strings and optionals for
// flexible API decoding.

/// An event from the CMS — stored in CaseDO as a record with category='event'.
/// Contains cleartext metadata (dates, location) plus E2EE encrypted details.
struct AppCaseEvent: Codable, Identifiable, Sendable {
    let id: String
    let hubId: String
    let entityTypeId: String
    let caseNumber: String?

    // Event-specific cleartext metadata
    let startDate: String
    let endDate: String?
    let parentEventId: String?
    let locationPrecision: String?
    let locationApproximate: String?

    // Blind indexes
    let eventTypeHash: String
    let statusHash: String
    let blindIndexes: [String: AnyCodable]?

    // E2EE encrypted details — uses CaseEnvelope (= RecipientEnvelope)
    let encryptedDetails: String?
    let detailEnvelopes: [CaseEnvelope]?

    // Relationship counts
    let caseCount: Int?
    let reportCount: Int?
    let subEventCount: Int?

    // Timestamps
    let createdAt: String
    let updatedAt: String
    let createdBy: String?
}

// MARK: - AnyCodable (flexible JSON value)
// Client-only: used for heterogeneous blind index values.

/// Minimal wrapper for heterogeneous JSON values in blind indexes.
struct AnyCodable: Codable, Sendable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self) {
            value = str
        } else if let arr = try? container.decode([String].self) {
            value = arr
        } else if let num = try? container.decode(Int.self) {
            value = num
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else {
            value = ""
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let str = value as? String {
            try container.encode(str)
        } else if let arr = value as? [String] {
            try container.encode(arr)
        } else if let num = value as? Int {
            try container.encode(num)
        } else if let bool = value as? Bool {
            try container.encode(bool)
        } else {
            try container.encode(String(describing: value))
        }
    }
}

// MARK: - API Responses

struct EventsListResponse: Codable, Sendable {
    let events: [AppCaseEvent]
    let total: Int
    let page: Int?
    let limit: Int?
    let hasMore: Bool?
}

struct EventResponse: Codable, Sendable {
    let event: AppCaseEvent
}

struct SubEventsResponse: Codable, Sendable {
    let events: [AppCaseEvent]
}

// MARK: - Request Bodies

struct CreateEventRequest: Codable, Sendable {
    let entityTypeId: String
    let startDate: String
    let endDate: String?
    let parentEventId: String?
    let locationPrecision: String?
    let locationApproximate: String?
    /// `createEventBodySchema` requires both hashes — omitting them answered 400,
    /// so no event could ever be created from iOS. iOS stores the plaintext
    /// discriminators it filters on locally (same convention as record creation,
    /// which sends `entityType.defaultStatus` as `statusHash`).
    let eventTypeHash: String
    let statusHash: String
    let encryptedDetails: String
    let detailEnvelopes: [CaseEnvelope]
    let blindIndexes: [String: String]
}

struct UpdateEventRequest: Codable, Sendable {
    let startDate: String?
    let endDate: String?
    let locationApproximate: String?
    let locationPrecision: String?
}

// MARK: - Linked Records/Reports
// Client-only: generated `CaseEventListResponseLink` uses non-optional `linkedAt`/`linkedBy`
// and CodingKey-renamed `eventID`/`recordID`. This client model uses camelCase and optionals.

struct AppCaseEventLink: Codable, Sendable {
    let recordId: String
    let eventId: String
    let linkedAt: String?
    let linkedBy: String?
}

struct ReportEventLink: Codable, Sendable {
    let reportId: String
    let eventId: String
    let linkedAt: String?
    let linkedBy: String?
}

struct AppCaseEventLinksResponse: Codable, Sendable {
    let links: [AppCaseEventLink]
}

struct ReportEventLinksResponse: Codable, Sendable {
    let links: [ReportEventLink]
}
