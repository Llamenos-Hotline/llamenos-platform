import Foundation
import SwiftUI

// MARK: - ReportStatus
// Client-only: UI display properties (displayName, color, icon).
// Generated `SharedReportResponseStatus` has same cases (active/closed/waiting)
// but without UI properties.

/// Status of a report in its lifecycle.
enum ReportStatus: String, CaseIterable, Sendable {
    case waiting
    case active
    case closed

    var displayName: String {
        switch self {
        case .waiting: return NSLocalizedString("report_status_waiting", comment: "Waiting")
        case .active: return NSLocalizedString("report_status_active", comment: "Active")
        case .closed: return NSLocalizedString("report_status_closed", comment: "Closed")
        }
    }

    var color: Color {
        switch self {
        case .waiting: return .statusWarning
        case .active: return .statusActive
        case .closed: return .brandMutedForeground
        }
    }

    var icon: String {
        switch self {
        case .waiting: return "clock"
        case .active: return "person.fill"
        case .closed: return "checkmark.circle"
        }
    }
}

// MARK: - ReportStatusFilter
// Client-only: UI filter enum, not in protocol.

/// Filter options for the reports list.
enum ReportStatusFilter: String, CaseIterable, Sendable {
    case all
    case waiting
    case active
    case closed

    var displayName: String {
        switch self {
        case .all: return NSLocalizedString("report_filter_all", comment: "All")
        case .waiting: return NSLocalizedString("report_status_waiting", comment: "Waiting")
        case .active: return NSLocalizedString("report_status_active", comment: "Active")
        case .closed: return NSLocalizedString("report_status_closed", comment: "Closed")
        }
    }
}

// MARK: - ReportMetadata
// Client-only: generated `ConversationMetadata` uses different field names
// and types (e.g., TypeEnum enum vs raw string).

/// Metadata embedded in a report's conversation record.
struct ReportMetadata: Codable, Sendable {
    let type: String?
    let reportTitle: String?
    let reportCategory: String?
    let reportTypeId: String?
    let linkedCallId: String?
    let reportId: String?
}

// MARK: - ClientReportResponse
// Client-only: generated `ReportResponse` has `encryptedContent`, `readerEnvelopes`,
// `createdBy` fields that this client model doesn't have. Also uses
// `SharedReportResponseStatus` enum instead of raw string.

/// Server response for a single report from `GET /api/reports`.
/// Named `ClientReportResponse` to avoid conflict with generated `ReportResponse`.
struct ClientReportResponse: Codable, Identifiable, Sendable {
    let id: String
    let channelType: String
    let contactIdentifierHash: String?
    let assignedTo: String?
    let status: String
    let createdAt: String
    let updatedAt: String?
    let lastMessageAt: String?
    let messageCount: Int
    let metadata: ReportMetadata?

    var reportTitle: String {
        metadata?.reportTitle ?? NSLocalizedString("report_untitled", comment: "Untitled Report")
    }

    var reportCategory: String? { metadata?.reportCategory }

    var reportTypeId: String? { metadata?.reportTypeId }

    var statusEnum: ReportStatus { ReportStatus(rawValue: status) ?? .waiting }
}

// MARK: - ReportsListResponse

/// API response wrapper for the reports list.
struct ReportsListResponse: Codable, Sendable {
    let conversations: [ClientReportResponse]
    let total: Int
}

// MARK: - CreateReportRequest

/// Request body for `POST /api/reports`.
struct CreateReportRequest: Encodable, Sendable {
    let title: String
    let category: String?
    let encryptedContent: String
    let authorEnvelope: ProtocolKeyEnvelope
    let adminEnvelopes: [RecipientEnvelope]
}

// ReportCategoriesResponse is defined in the generated Types.swift (protocol codegen).
// No hand-written definition needed — shape is identical: `categories: [String]`.

// MARK: - ReportAssignRequest

/// Request body for `POST /api/reports/:id/assign`.
struct ReportAssignRequest: Encodable, Sendable {
    /// #1633: `assignReportBodySchema` names this `assignedTo`, and requires it.
    /// It was `assignTo` here — a key the schema does not declare.
    let assignedTo: String
}

// MARK: - ReportUpdateRequest

/// Request body for `PATCH /api/reports/:id`.
struct ReportUpdateRequest: Encodable, Sendable {
    let status: String
}
