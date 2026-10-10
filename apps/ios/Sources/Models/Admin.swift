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

// MARK: - UserListResponseUser display helpers
//
// The admin user list decodes the generated `UserListResponse`
// (`GET /api/users`, `userListResponseSchema`). The hand-written `ClientUser`
// this replaced (`displayName: String?`, `role: String`, `status: String`,
// `id`) described no route the server has ever mounted — it was the decoding
// half of the `/api/identity/members` 404s in #1046. UI display helpers live
// here as an extension so the view works on the wire type directly.

extension UserListResponseUser: Identifiable {
    /// Stable identity for SwiftUI lists — the user's pubkey.
    var id: String { pubkey }

    /// Whether the user holds any admin role (super-admin or hub admin).
    /// Same heuristic `AppState.fetchUserRole` applies to `GET /api/auth/me`.
    var isAdmin: Bool {
        roles.contains { $0.contains("admin") }
    }

    /// The user's current single role ID, for the role menu's checkmark.
    /// The server keeps `roles` as a list; the iOS menu assigns one at a time,
    /// like the desktop user row (`user.roles[0]`).
    var primaryRoleId: String? { roles.first }

    /// Display name or truncated pubkey.
    var displayLabel: String {
        if !name.isEmpty {
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

// MARK: - Invite display helpers
//
// The admin invite list decodes the generated `InviteListResponse`
// (`GET /api/invites`, `inviteListResponseSchema`). The hand-written
// `AppInvite` this replaced (`role: String`, `claimedBy`, `id`) matched no
// server response — `usedBy`/`roleIds` are the wire fields — so every invite
// list decode against the real route would have failed even had the path been
// right (#1046).

extension Invite: Identifiable {
    /// Stable identity for SwiftUI lists — the invite code (a UUID).
    var id: String { code }

    /// Whether this invite has been claimed.
    var isClaimed: Bool { usedBy != nil || usedAt != nil }

    /// Whether this invite has expired.
    var isExpired: Bool {
        guard let date = expiresDate else { return false }
        return date < Date()
    }

    /// Whether this invite is currently usable (not claimed and not expired).
    var isActive: Bool { !isClaimed && !isExpired }

    /// Whether the invite grants an admin role.
    var grantsAdminRole: Bool {
        roleIDS.contains { $0.contains("admin") }
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

/// Response envelope of `POST /api/invites` (`{ "invite": {…} }`, 201). The
/// invite itself is the generated `Invite` (`inviteResponseSchema`); only the
/// wrapper is local — the schema registry has no named schema for it.
struct CreateInviteResponse: Decodable, Sendable {
    let invite: Invite
}

// MARK: - Request Types

/// Request body for `POST /api/bans`.
struct CreateBanRequest: Encodable, Sendable {
    let identifierHash: String
    let reason: String?
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
// The API payload decodes into the protocol-generated `SystemHealthResponse`
// (packages/protocol/schemas/system.ts → generated Types.swift). The types below
// are display models that SystemHealthView maps each response section onto.

/// Status of an individual service or subsystem (display model for health cards).
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
