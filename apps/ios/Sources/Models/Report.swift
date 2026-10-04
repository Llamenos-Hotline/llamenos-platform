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

// MARK: - Report conversation UI extensions
// Report lists decode to generated `ReportListResponse` whose elements are
// generated `SharedConversation` — the reports list IS the report-type
// conversation list (packages/protocol/schemas/reports.ts +
// conversations.ts). Only the display helpers below are client-side.

extension SharedConversation: Identifiable {}

extension SharedConversation {
    var reportTitle: String {
        metadata?.reportTitle ?? NSLocalizedString("report_untitled", comment: "Untitled Report")
    }

    var reportCategory: String? { metadata?.reportCategory }

    var reportTypeId: String? { metadata?.reportTypeID }

    var statusEnum: ReportStatus {
        status.flatMap { ReportStatus(rawValue: $0.rawValue) } ?? .waiting
    }
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
    let assignTo: String
}

// MARK: - ReportUpdateRequest

/// Request body for `PATCH /api/reports/:id`.
struct ReportUpdateRequest: Encodable, Sendable {
    let status: String
}
