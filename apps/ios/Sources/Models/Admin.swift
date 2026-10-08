import Foundation

// MARK: - UserRole
// Client-only: UI display properties (displayName, badgeColor) not in protocol codegen.
// Generated `UserListResponseUser` uses `roles: [String]` (array of role names) —
// fundamentally different shape from this single-role enum.

/// Roles in the system, matching the protocol spec.
enum UserRole: String, Codable, Sendable, CaseIterable {
    case volunteer
    case admin

    var displayName: String {
        switch self {
        case .volunteer: return NSLocalizedString("role_volunteer", comment: "Volunteer")
        case .admin: return NSLocalizedString("role_admin", comment: "Admin")
        }
    }

    var badgeColor: String {
        switch self {
        case .volunteer: return "blue"
        case .admin: return "purple"
        }
    }
}

// MARK: - ClientUserStatus
// Client-only: UI display properties. Generated `UserListResponseUser` uses
// `active: Bool` — different representation.

/// User account status (client-side enum with UI properties).
/// Named `ClientUserStatus` to avoid conflict with generated `UserStatus`.
enum ClientUserStatus: String, Codable, Sendable, CaseIterable {
    case active
    case inactive
    case suspended

    var displayName: String {
        switch self {
        case .active: return NSLocalizedString("status_active", comment: "Active")
        case .inactive: return NSLocalizedString("status_inactive", comment: "Inactive")
        case .suspended: return NSLocalizedString("status_suspended", comment: "Suspended")
        }
    }
}

// MARK: - ClientUser
// Client-only: different shape from generated `UserListResponseUser` which has
// `active: Bool`, `roles: [String]`, `name: String` (non-optional) — our client
// model uses `displayName: String?`, `role: String` (single), `status: String`.

/// A user/admin member from the API (client-side model with UI properties).
/// Named `ClientUser` to avoid conflict with generated `User`.
struct ClientUser: Codable, Identifiable, Sendable {
    let id: String
    let pubkey: String
    let displayName: String?
    let role: String
    let status: String
    let createdAt: String

    /// Parsed role enum.
    var userRole: UserRole {
        UserRole(rawValue: role) ?? .volunteer
    }

    /// Parsed status enum.
    var userStatus: ClientUserStatus {
        ClientUserStatus(rawValue: status) ?? .active
    }

    /// Display name or truncated pubkey.
    var displayLabel: String {
        if let name = displayName, !name.isEmpty {
            return name
        }
        return truncatedPubkey
    }

    /// Truncated pubkey for display.
    var truncatedPubkey: String {
        guard pubkey.count > 16 else { return pubkey }
        return "\(pubkey.prefix(8))...\(pubkey.suffix(6))"
    }

    /// Parsed creation date.
    var createdDate: Date? {
        DateFormatting.parseISO(createdAt)
    }
}

// MARK: - AppBanEntry
// Client-only: generated `Ban` has different fields (phone, bannedAt, bannedBy)
// vs our (id, identifierHash, reason?, createdBy, createdAt).

/// A ban list entry from the API (client-side model with UI properties).
/// Named `AppBanEntry` to avoid conflict with generated `Ban`/`BanResponse`.
struct AppBanEntry: Codable, Identifiable, Sendable {
    let id: String
    let identifierHash: String
    let reason: String?
    let createdBy: String
    let createdAt: String
    let hubId: String?

    /// Truncated identifier hash for display.
    var truncatedHash: String {
        guard identifierHash.count > 16 else { return identifierHash }
        return "\(identifierHash.prefix(8))...\(identifierHash.suffix(6))"
    }

    /// Truncated creator pubkey for display.
    var creatorDisplay: String {
        guard createdBy.count > 16 else { return createdBy }
        return "\(createdBy.prefix(8))...\(createdBy.suffix(6))"
    }

    /// Parsed creation date.
    var createdDate: Date? {
        DateFormatting.parseISO(createdAt)
    }
}

// MARK: - AppAuditEntry
// Client-only: generated `SharedEntry`/`AuditEntryResponse` uses `details: [String: JSONAny]`
// while this client model uses `details: String?`.
// `SharedEntry` (formerly a distinct per-schema type) is now shared with
// `EvidenceAccessLogResponse.entries` — codegen dedups identical entry shapes across schemas.

/// A hash-chained audit log entry from the API (client-side model with UI properties).
/// Named `AppAuditEntry` to avoid conflict with generated `AuditEntryResponse`/`SharedEntry`.
struct AppAuditEntry: Codable, Identifiable, Sendable {
    let id: String
    let action: String
    let actorPubkey: String
    let details: String?
    let entryHash: String
    let previousEntryHash: String?
    let timestamp: String

    /// Truncated actor pubkey for display.
    var actorDisplay: String {
        guard actorPubkey.count > 16 else { return actorPubkey }
        return "\(actorPubkey.prefix(8))...\(actorPubkey.suffix(6))"
    }

    /// Truncated entry hash for display.
    var truncatedEntryHash: String {
        guard entryHash.count > 16 else { return entryHash }
        return "\(entryHash.prefix(8))...\(entryHash.suffix(6))"
    }

    /// Parsed timestamp.
    var timestampDate: Date? {
        DateFormatting.parseISO(timestamp)
    }

    /// Human-readable action description.
    var actionDisplay: String {
        action.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

// MARK: - AppInvite
// Client-only: generated `Invite` has different fields (name, phone, roleIDs)
// vs our (code, role, createdBy, claimedBy, expiresAt).

/// An invite code from the API (client-side model with UI properties).
/// Named `AppInvite` to avoid conflict with generated `Invite` from protocol codegen.
struct AppInvite: Codable, Identifiable, Sendable {
    let id: String
    let code: String
    let role: String
    let createdBy: String
    let claimedBy: String?
    let expiresAt: String
    let createdAt: String

    /// Whether this invite has been claimed.
    var isClaimed: Bool { claimedBy != nil }

    /// Whether this invite has expired.
    var isExpired: Bool {
        guard let date = expiresDate else { return false }
        return date < Date()
    }

    /// Whether this invite is currently usable (not claimed and not expired).
    var isActive: Bool { !isClaimed && !isExpired }

    /// Parsed role enum.
    var inviteRole: UserRole {
        UserRole(rawValue: role) ?? .volunteer
    }

    /// Parsed expiry date.
    var expiresDate: Date? {
        DateFormatting.parseISO(expiresAt)
    }

    /// Parsed creation date.
    var createdDate: Date? {
        DateFormatting.parseISO(createdAt)
    }

    /// Truncated creator pubkey.
    var creatorDisplay: String {
        guard createdBy.count > 16 else { return createdBy }
        return "\(createdBy.prefix(8))...\(createdBy.suffix(6))"
    }
}

// MARK: - API Response Types

/// API response for the users list.
struct UsersListResponse: Codable, Sendable {
    let members: [ClientUser]
}

/// API response for the ban list (client-side).
/// Named `AppBanListResponse` to avoid conflict with generated `BanListResponse`.
struct AppBanListResponse: Codable, Sendable {
    let bans: [AppBanEntry]
}

/// API response for the audit log.
struct AuditLogResponse: Codable, Sendable {
    let entries: [AppAuditEntry]
    let total: Int
}

/// API response for the invites list.
struct InvitesListResponse: Codable, Sendable {
    let invites: [AppInvite]
}

// MARK: - Request Types

/// Request body for `POST /api/identity/invite`.
struct CreateInviteRequest: Encodable, Sendable {
    let role: String
}

/// Request body for `POST /api/bans`.
struct CreateBanRequest: Encodable, Sendable {
    let identifierHash: String
    let reason: String?
}

/// Request body for `PATCH /api/identity/:pubkey/role`.
struct UpdateRoleRequest: Encodable, Sendable {
    let role: String
}

// MARK: - Report Category
// Client-only: generated `ReportTypeListResponseReportType` has a different shape.

/// A report category from the API.
struct ReportCategory: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let createdAt: String?

    /// Parsed creation date.
    var createdDate: Date? {
        guard let createdAt else { return nil }
        return DateFormatting.parseISO(createdAt)
    }
}

/// API response from `GET /api/settings/report-types`.
struct ReportTypesResponse: Codable, Sendable {
    let reportTypes: [ReportCategory]
}

/// Request body for `POST /api/settings/report-types`.
struct CreateReportCategoryRequest: Encodable, Sendable {
    let name: String
}

// MARK: - Telephony Provider Selection
//
// The telephony screen used to hold a hand-written `ClientTelephonyProvider`
// enum listing five providers, with its own `displayName`, and a hand-written
// `TelephonySettings { provider, accountSid, authToken, phoneNumber }` that
// described neither the read shape (`telephonyProviderSchema`, surfaced as
// `TelephonyProvider`) nor the write shape (`configureProviderRequestSchema`,
// as `ConfigureProviderRequest`). An operator on Telnyx, Bandwidth or
// FreeSWITCH could not select their own provider at all.
//
// Both are gone. The screen uses the generated `SharedProviderType`, whose
// eight cases are exactly the eight `telephonyProviderTypeSchema` accepts, and
// `ProviderInfo.all` (ViewModels/ProviderSetup/ProviderSetupViewModel.swift) —
// which already listed all eight, in picker order, with the `displayName` the
// provider-setup screens show. See #1724.

// MARK: - Client Call Settings
// Client-only: generated `CallSettings` has different fields (maxDuration: Double, etc.).

/// Call routing configuration from the API (client-side model).
/// Named `ClientCallSettings` to avoid conflict with generated `CallSettings`.
struct ClientCallSettings: Codable, Sendable {
    var ringTimeout: Int
    var maxDuration: Int
    var parallelRingCount: Int
}

// The IVR, transcription and spam screens used to each carry a hand-written
// `Client*` struct here. Every one of them named fields the server does not
// have — `ClientIvrLanguages.languages` as a `[String: Bool]` map against the
// ordered `enabledLanguages` array, `ClientTranscriptionSettings.enabled /
// allowVolunteerOptOut` against `globalEnabled / allowUserOptOut`, and
// `ClientSpamSettings.maxCallsPerHour / knownNumberBypass` against
// `maxCallsPerMinute / rateLimitEnabled / blockDurationMinutes` — so every GET
// failed to decode and every screen showed hardcoded defaults behind an error
// banner. They are gone; the screens use the generated `IvrLanguages`,
// `TranscriptionSettings` and `SpamSettings`. See #1724.

// MARK: - System Health
// Client-only: generated `HealthResponse` has different shape (checks array, not named services).

/// System health dashboard data from the API.
struct SystemHealth: Codable, Sendable {
    let server: ServiceHealthStatus
    let services: ServiceHealthStatus
    let calls: ServiceHealthStatus
    let storage: ServiceHealthStatus
    let backup: ServiceHealthStatus
    let volunteers: ServiceHealthStatus
}

/// Status of an individual service or subsystem.
struct ServiceHealthStatus: Codable, Sendable {
    let name: String
    let status: String
    let details: String?

    /// Parsed status for display.
    var healthLevel: HealthLevel {
        switch status.lowercased() {
        case "healthy", "ok", "up": return .healthy
        case "degraded", "warning", "slow": return .degraded
        default: return .critical
        }
    }
}

/// Health level for status indicators.
enum HealthLevel: Sendable {
    case healthy
    case degraded
    case critical

    var color: String {
        switch self {
        case .healthy: return "green"
        case .degraded: return "yellow"
        case .critical: return "red"
        }
    }

    var icon: String {
        switch self {
        case .healthy: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .critical: return "xmark.circle.fill"
        }
    }
}
