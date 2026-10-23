import Foundation

// MARK: - Hub types (from protocol codegen)
// The protocol codegen generates:
//   - `Hub` (simple: id, name, slug, status as String) — used in ConfigResponse.hubs
//   - `SharedHub` (full: all fields including description, phoneNumber, dates, SharedHubDetailResponseStatus)
//   - `HubResponse` (same shape as SharedHub, used by single-hub endpoints)
//   - `HubListResponse` with `hubs: [SharedHub]`
//   - `HubDetailResponse` with `hub: SharedHub`
//
// The iOS app uses SharedHub as its primary hub type since it needs the full fields.

extension SharedHub: Identifiable {}
extension SharedHub: Equatable {
    public static func == (lhs: SharedHub, rhs: SharedHub) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - HubStatus display extensions

typealias HubStatus = SharedHubDetailResponseStatus

extension SharedHubDetailResponseStatus {
    var displayName: String {
        switch self {
        case .active:
            return NSLocalizedString("hubs_status_active", comment: "Active")
        case .suspended:
            return NSLocalizedString("hubs_status_suspended", comment: "Suspended")
        case .archived:
            return NSLocalizedString("hubs_status_archived", comment: "Archived")
        }
    }

    var color: String {
        switch self {
        case .active: return "green"
        case .suspended: return "yellow"
        case .archived: return "red"
        }
    }
}

// MARK: - API Responses

/// API response wrapper for the hubs list.
/// Uses the generated `HubListResponse` directly — `hubs: [SharedHub]`.
typealias HubsListResponse = HubListResponse

/// API response wrapper for a single hub (e.g. POST /api/hubs).
/// Uses the generated `HubDetailResponse` — `hub: SharedHub`.
typealias AppHubResponse = HubDetailResponse

// MARK: - Request Bodies
// Create/update bodies are the generated `CreateHubBody` / `UpdateHubBody`
// (updateHubBodySchema adds optional `slug` and `status`).

// HubKeyEnvelopeResponse and HubKeyEnvelopeResponseEnvelope are generated from
// packages/protocol/generated/swift/Types.swift — do not redefine here.
