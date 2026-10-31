import Foundation
import UIKit

// MARK: - AdminTab

/// Sub-tabs within the admin section.
enum AdminTab: String, CaseIterable, Sendable {
    case volunteers
    case bans
    case auditLog
    case invites
    case customFields
    case reportCategories
    case telephonySettings
    case callSettings
    case ivrSettings
    case transcriptionSettings
    case spamSettings
    case systemHealth

    var title: String {
        switch self {
        case .volunteers: return NSLocalizedString("admin_tab_users", comment: "Volunteers")
        case .bans: return NSLocalizedString("admin_tab_bans", comment: "Ban List")
        case .auditLog: return NSLocalizedString("admin_tab_audit", comment: "Audit Log")
        case .invites: return NSLocalizedString("admin_tab_invites", comment: "Invites")
        case .customFields: return NSLocalizedString("admin_tab_fields", comment: "Fields")
        case .reportCategories: return NSLocalizedString("admin_report_categories", comment: "Report Categories")
        case .telephonySettings: return NSLocalizedString("admin_telephony_settings", comment: "Telephony")
        case .callSettings: return NSLocalizedString("admin_call_settings", comment: "Call Settings")
        case .ivrSettings: return NSLocalizedString("admin_ivr_settings", comment: "IVR Languages")
        case .transcriptionSettings: return NSLocalizedString("admin_transcription_settings", comment: "Transcription")
        case .spamSettings: return NSLocalizedString("admin_spam_settings", comment: "Spam Settings")
        case .systemHealth: return NSLocalizedString("admin_system_health", comment: "System Health")
        }
    }

    var icon: String {
        switch self {
        case .volunteers: return "person.3.fill"
        case .bans: return "hand.raised.fill"
        case .auditLog: return "list.clipboard.fill"
        case .invites: return "envelope.open.fill"
        case .customFields: return "list.bullet.rectangle.fill"
        case .reportCategories: return "tag.fill"
        case .telephonySettings: return "phone.connection.fill"
        case .callSettings: return "slider.horizontal.3"
        case .ivrSettings: return "globe"
        case .transcriptionSettings: return "text.word.spacing"
        case .spamSettings: return "shield.lefthalf.filled"
        case .systemHealth: return "heart.text.square.fill"
        }
    }
}

// MARK: - AdminViewModel

/// View model for admin management screens. Handles CRUD operations for
/// volunteers, bans, audit log, and invite codes.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class AdminViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService

    // MARK: - Users State

    /// All users/members from the server.
    var users: [ClientUser] = []

    /// Filtered users based on search text.
    var filteredUsers: [ClientUser] {
        if userSearchText.isEmpty {
            return users
        }
        let query = userSearchText.lowercased()
        return users.filter { user in
            (user.displayName?.lowercased().contains(query) ?? false)
                || user.pubkey.lowercased().contains(query)
                || user.role.lowercased().contains(query)
        }
    }

    /// Search text for user filtering.
    var userSearchText: String = ""

    /// Whether users are loading.
    var isLoadingUsers: Bool = false

    // MARK: - Ban List State

    /// All ban entries from the server.
    var bans: [BanListResponseBan] = []

    /// Whether bans are loading.
    var isLoadingBans: Bool = false

    /// Whether the add ban sheet is showing.
    var showAddBanSheet: Bool = false

    /// Input for new ban identifier hash.
    var newBanIdentifierHash: String = ""

    /// Input for new ban reason.
    var newBanReason: String = ""

    // MARK: - Audit Log State

    /// Audit log entries from the server.
    var auditEntries: [SharedEntry] = []

    /// Total count of audit entries for pagination.
    var auditTotal: Int = 0

    /// Whether audit entries are loading.
    var isLoadingAudit: Bool = false

    /// Whether more audit entries are loading (pagination).
    var isLoadingMoreAudit: Bool = false

    /// Whether there are more audit entries to load.
    var hasMoreAudit: Bool = true

    /// Current audit log page.
    private var auditPage: Int = 1
    private let auditPageSize: Int = 50

    // MARK: - Invites State

    /// All invite codes from the server.
    var invites: [Invite] = []

    /// Whether invites are loading.
    var isLoadingInvites: Bool = false

    /// Whether the create invite sheet is showing.
    var showCreateInviteSheet: Bool = false

    /// Selected role for new invite.
    var newInviteRole: UserRole = .volunteer

    /// Name of the person being invited (required by the server).
    var newInviteName: String = ""

    /// Phone number of the person being invited.
    var newInvitePhone: String = ""

    // MARK: - Custom Fields State

    /// All custom field definitions.
    var customFields: [CustomFieldsBodyField] = []

    /// Whether custom fields are loading.
    var isLoadingFields: Bool = false

    /// Whether the field editor sheet is showing.
    var showFieldEditor: Bool = false

    /// The field being edited (nil for create).
    var editingField: CustomFieldsBodyField?

    // MARK: - Report Categories State

    /// All report categories from the server.
    var reportCategories: [ReportCategory] = []

    /// Whether report categories are loading.
    var isLoadingReportCategories: Bool = false

    /// Whether the new category alert is showing.
    var showNewCategoryAlert: Bool = false

    /// Input for new category name.
    var newCategoryName: String = ""

    // MARK: - Telephony Settings State

    /// The telephony provider screen's editable state.
    ///
    /// Held as separate fields rather than as a generated `TelephonyProvider`
    /// because that struct's properties are `let` and because the read and the
    /// write use two different shapes: `GET /api/settings/telephony-provider`
    /// answers `telephonyProviderSchema` (`TelephonyProvider`), while the write
    /// is `POST /api/provider-setup/configure` taking
    /// `configureProviderRequestSchema` (`ConfigureProviderRequest`), which
    /// carries the credentials as a `[String: String]` so the server can
    /// encrypt them at rest. Both are converted at the wire boundary and
    /// neither is re-described here.
    ///
    /// This replaces a hand-written `TelephonySettings { provider, accountSid,
    /// authToken, phoneNumber }` sent to `GET`/`PUT /api/settings/telephony` —
    /// a path the server has never mounted, 404 on both verbs. See #1724.
    var telephonyProvider: SharedProviderType = .twilio
    var telephonyAccountSid: String = ""
    var telephonyAuthToken: String = ""
    var telephonyPhoneNumber: String = ""

    /// Whether telephony settings are loading.
    var isLoadingTelephony: Bool = false

    /// Whether telephony settings are being saved.
    var isSavingTelephony: Bool = false

    // MARK: - Call Settings State

    /// The server's call settings are exactly two values, both in seconds and
    /// both clamped to 30...300 server-side — `callSettingsSchema` in
    /// `packages/protocol/schemas/settings.ts`, surfaced to Swift as the
    /// generated `CallSettings`. They are held here as two `Int`s because the
    /// generated struct's fields are `let` and optional: this is the screen's
    /// editable state, converted to and from `CallSettings` at the wire
    /// boundary and never a second description of the wire shape.
    ///
    /// They replace a hand-written `ClientCallSettings { ringTimeout,
    /// maxDuration, parallelRingCount }`, which named three settings the server
    /// has never had. `GET /api/settings/call` could not decode into it, so the
    /// screen showed hardcoded defaults behind an error banner, and the save
    /// went to `PUT /api/settings/call` — a route that does not exist, answering
    /// 404 on every attempt. See #1717.
    var queueTimeoutSeconds: Int = AdminViewModel.defaultQueueTimeoutSeconds
    var voicemailMaxSeconds: Int = AdminViewModel.defaultVoicemailMaxSeconds

    /// Shown when the server has not stored a value yet; the same defaults the
    /// server's own settings service falls back to.
    static let defaultQueueTimeoutSeconds = 90
    static let defaultVoicemailMaxSeconds = 120

    /// The range both sliders span, matching the server's clamp. A value
    /// outside it is rejected by `callSettingsSchema` before it is stored.
    static let callSecondsRange: ClosedRange<Double> = 30...300

    /// Whether call settings are loading.
    var isLoadingCallSettings: Bool = false

    /// Whether call settings are being saved.
    var isSavingCallSettings: Bool = false

    // MARK: - IVR Languages State

    /// The IVR languages the hub offers, in the order callers hear them — which
    /// is the whole of `ivrLanguagesSchema` (`{ enabledLanguages: [String] }`,
    /// generated as `IvrLanguages`). Position is meaningful: it decides which
    /// keypad digit selects each language, and languages past position 8 move
    /// into a sub-menu.
    ///
    /// It replaces a `[String: Bool]` map, which lost that order entirely and
    /// which the route rejects outright: `PATCH /api/settings/ivr-languages`
    /// with `{"languages":{...}}` answers 400 `expected array, received
    /// undefined` at `enabledLanguages`. See #1724.
    var ivrEnabledLanguages: [String] = []

    /// Whether IVR languages are loading.
    var isLoadingIvrLanguages: Bool = false

    /// Whether IVR languages are being saved.
    var isSavingIvrLanguages: Bool = false

    // MARK: - Transcription Settings State

    /// The two transcription settings the server has — `globalEnabled` and
    /// `allowUserOptOut` of `transcriptionSettingsSchema`, generated as
    /// `TranscriptionSettings`. They replace a hand-written `{ enabled,
    /// allowVolunteerOptOut }`, which the GET's response could not decode into.
    var transcriptionGlobalEnabled: Bool = false
    var transcriptionAllowUserOptOut: Bool = false

    /// Whether transcription settings are loading.
    var isLoadingTranscription: Bool = false

    /// Whether transcription settings are being saved.
    var isSavingTranscription: Bool = false

    // MARK: - Spam Settings State

    /// The four spam-mitigation settings the server has (`spamSettingsSchema`,
    /// generated as `SpamSettings`).
    ///
    /// They replace a hand-written `{ maxCallsPerHour, voiceCaptchaEnabled,
    /// knownNumberBypass }`: the rate limit is per *minute*, not per hour, there
    /// is a block duration the screen never offered, and the server has no
    /// known-number bypass at all — so that toggle controlled nothing, in
    /// either direction, and claimed to exempt callers from the CAPTCHA.
    var spamVoiceCaptchaEnabled: Bool = false
    var spamRateLimitEnabled: Bool = true
    var spamMaxCallsPerMinute: Int = AdminViewModel.defaultMaxCallsPerMinute
    var spamBlockDurationMinutes: Int = AdminViewModel.defaultBlockDurationMinutes

    /// Shown until the server answers; the same values its own defaults use.
    static let defaultMaxCallsPerMinute = 3
    static let defaultBlockDurationMinutes = 30

    /// The ranges `spamSettingsSchema` accepts. A value outside one is rejected
    /// by the validator before anything is stored.
    static let maxCallsPerMinuteRange = 1...100
    static let blockDurationMinutesRange = 1...1440

    /// Whether spam settings are loading.
    var isLoadingSpamSettings: Bool = false

    /// Whether spam settings are being saved.
    var isSavingSpamSettings: Bool = false

    // MARK: - System Health State

    /// Current system health data.
    var systemHealth: SystemHealthResponse?

    /// Whether system health is loading.
    var isLoadingHealth: Bool = false

    // MARK: - Erasure Queue State

    /// Pending erasure requests from the API.
    var erasureRequests: [SharedRequest] = []

    /// Whether erasure requests are loading.
    var isLoadingErasure: Bool = false

    /// Filter for erasure queue (nil = all).
    var erasureStatusFilter: String?

    /// Whether the immediate erasure dialog is showing.
    var showImmediateErasureDialog: Bool = false

    /// Target user for immediate erasure.
    var immediateErasureTargetId: String?

    /// Justification text for immediate erasure.
    var immediateErasureJustification: String = ""

    // MARK: - Retention Settings State

    /// Per-hub retention settings (category -> days).
    var retentionSettings: [AppRetentionCategory] = []

    /// Whether retention settings are loading.
    var isLoadingRetention: Bool = false

    /// Whether retention settings are being saved.
    var isSavingRetention: Bool = false

    // MARK: - Platform Bans State

    /// Platform-scoped bans from the API.
    var platformBans: [PlatformBanListResponseBan] = []

    /// Whether platform bans are loading.
    var isLoadingPlatformBans: Bool = false

    /// Whether the add platform ban sheet is showing.
    var showAddPlatformBanSheet: Bool = false

    /// Search query for cross-hub ban search.
    var platformBanSearchQuery: String = ""

    /// Search results from cross-hub search.
    var platformBanSearchResults: [SearchBansResponseBan] = []

    // MARK: - Shared State

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Success message for completed actions.
    var successMessage: String?

    /// Whether a destructive action confirmation is showing.
    var showDeleteConfirmation: Bool = false

    /// The ID of the item pending deletion.
    var pendingDeleteId: String?

    /// Type of pending deletion.
    var pendingDeleteType: DeleteType?

    // MARK: - Initialization

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    // MARK: - Users

    /// Load all users from the API.
    func loadUsers() async {
        guard !isLoadingUsers else { return }
        isLoadingUsers = true
        errorMessage = nil

        do {
            let response: UsersListResponse = try await apiService.request(
                method: "GET",
                path: "/api/identity/members"
            )
            users = response.members.sorted { lhs, rhs in
                // Admins first, then by display name
                if lhs.role != rhs.role {
                    return lhs.userRole == .admin
                }
                return (lhs.displayName ?? lhs.pubkey) < (rhs.displayName ?? rhs.pubkey)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingUsers = false
    }

    /// Update a user's role.
    func updateUserRole(pubkey: String, newRole: UserRole) async {
        errorMessage = nil
        successMessage = nil

        do {
            // The server has no role-only endpoint: a role change is a user
            // update carrying role IDs, scoped to the hub being browsed — the
            // same call the desktop client makes (#1701).
            try await apiService.request(
                method: "PATCH",
                path: apiService.hp("/api/users/\(pubkey)"),
                body: AdminUpdateUserBody.roles([newRole.roleId])
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("admin_role_updated", comment: "Role updated successfully")
            await loadUsers()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Bans

    /// Load the ban list from the API.
    func loadBans() async {
        guard !isLoadingBans else { return }
        isLoadingBans = true
        errorMessage = nil

        do {
            let response: BanListResponse = try await apiService.request(
                method: "GET",
                path: "/api/bans"
            )
            bans = response.bans.sorted { lhs, rhs in
                (lhs.bannedDate ?? Date.distantPast) > (rhs.bannedDate ?? Date.distantPast)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingBans = false
    }

    /// Add a new ban entry.
    func addBan() async {
        let hash = newBanIdentifierHash.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hash.isEmpty else {
            errorMessage = NSLocalizedString("admin_ban_hash_required", comment: "Identifier hash is required")
            return
        }

        errorMessage = nil
        successMessage = nil

        do {
            let reason = newBanReason.trimmingCharacters(in: .whitespacesAndNewlines)
            let request = CreateBanRequest(
                identifierHash: hash,
                reason: reason.isEmpty ? nil : reason
            )
            try await apiService.request(
                method: "POST",
                path: "/api/bans",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            newBanIdentifierHash = ""
            newBanReason = ""
            showAddBanSheet = false
            successMessage = NSLocalizedString("admin_ban_added", comment: "Ban entry added")
            await loadBans()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Remove a ban entry.
    func removeBan(id: String) async {
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "DELETE",
                path: "/api/bans/\(id)"
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("admin_ban_removed", comment: "Ban entry removed")
            await loadBans()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Audit Log

    /// Load the first page of audit log entries.
    func loadAuditLog() async {
        guard !isLoadingAudit else { return }
        isLoadingAudit = true
        errorMessage = nil
        auditPage = 1

        do {
            let response: AuditListResponse = try await apiService.request(
                method: "GET",
                path: apiService.activeHubPath("/api/audit") + "?page=1&limit=\(auditPageSize)"
            )
            auditEntries = response.entries
            auditTotal = Int(response.total)
            hasMoreAudit = auditEntries.count < Int(response.total)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingAudit = false
    }

    /// Load the next page of audit log entries.
    func loadMoreAuditEntries() async {
        guard !isLoadingMoreAudit, hasMoreAudit else { return }
        isLoadingMoreAudit = true

        let nextPage = auditPage + 1

        do {
            let response: AuditListResponse = try await apiService.request(
                method: "GET",
                path: apiService.activeHubPath("/api/audit") + "?page=\(nextPage)&limit=\(auditPageSize)"
            )
            auditEntries.append(contentsOf: response.entries)
            auditPage = nextPage
            auditTotal = Int(response.total)
            hasMoreAudit = auditEntries.count < Int(response.total)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingMoreAudit = false
    }

    // MARK: - Invites

    /// Load all invite codes from the API.
    func loadInvites() async {
        guard !isLoadingInvites else { return }
        isLoadingInvites = true
        errorMessage = nil

        do {
            // Not hp(): the server mounts invites at /api/invites only,
            // unscoped (#1701).
            let response: InviteListResponse = try await apiService.request(
                method: "GET",
                path: "/api/invites"
            )
            invites = response.invites.sorted { lhs, rhs in
                (lhs.createdDate ?? Date.distantPast) > (rhs.createdDate ?? Date.distantPast)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingInvites = false
    }

    /// Generate a new invite code.
    func createInvite() async {
        errorMessage = nil
        successMessage = nil

        do {
            // The server requires a name and phone and takes role IDs. The
            // route is not hub-scoped, so the hub travels in the body — without
            // it the server 400s once it has several hubs (#1037).
            let request = CreateInviteBody(
                hubID: apiService.activeHubId,
                name: newInviteName.trimmingCharacters(in: .whitespacesAndNewlines),
                phone: newInvitePhone.trimmingCharacters(in: .whitespacesAndNewlines),
                roleIDS: [newInviteRole.roleId]
            )
            let _: CreateInviteResponse = try await apiService.request(
                method: "POST",
                path: "/api/invites",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            showCreateInviteSheet = false
            newInviteName = ""
            newInvitePhone = ""
            successMessage = NSLocalizedString("admin_invite_created", comment: "Invite code created")
            await loadInvites()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Custom Fields

    /// Load custom field definitions from the API.
    func loadCustomFields() async {
        guard !isLoadingFields else { return }
        isLoadingFields = true
        errorMessage = nil

        do {
            let response: CustomFieldsListResponse = try await apiService.request(
                method: "GET",
                path: "/api/settings/custom-fields?role=admin"
            )
            // `GET` returns whole stored rows; the editor works in the PUT
            // shape, which is the subset `customFieldsBodySchema` accepts.
            customFields = response.fields
                .sorted { $0.order < $1.order }
                .map(\.bodyField)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingFields = false
    }

    /// Save the entire custom fields list (PUT replaces all).
    func saveCustomFields() async {
        errorMessage = nil
        successMessage = nil

        do {
            let body = CustomFieldsBody(fields: customFields)
            try await apiService.request(
                method: "PUT",
                path: "/api/settings/custom-fields",
                body: body
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("admin_fields_saved", comment: "Custom fields saved")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Add or update a field in the local list, then save to server.
    func saveField(_ field: CustomFieldsBodyField) async {
        if let index = customFields.firstIndex(where: { $0.name == field.name }) {
            customFields[index] = field
        } else {
            customFields.append(field)
        }
        await saveCustomFields()
        showFieldEditor = false
        editingField = nil
    }

    /// Delete a field by ID, then save to server.
    func deleteField(name: String) async {
        customFields.removeAll { $0.name == name }
        await saveCustomFields()
    }

    // MARK: - Report Categories

    /// Load all report categories from the API.
    func loadReportCategories() async {
        guard !isLoadingReportCategories else { return }
        isLoadingReportCategories = true
        errorMessage = nil

        do {
            let response: ReportTypesResponse = try await apiService.request(
                method: "GET",
                path: "/api/settings/report-types"
            )
            reportCategories = response.reportTypes.sorted { lhs, rhs in
                lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingReportCategories = false
    }

    /// Create a new report category.
    func createReportCategory(name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = NSLocalizedString(
                "admin_category_name_required",
                comment: "Category name is required"
            )
            return
        }

        errorMessage = nil
        successMessage = nil

        do {
            let request = CreateReportCategoryRequest(name: trimmed)
            try await apiService.request(
                method: "POST",
                path: "/api/settings/report-types",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            newCategoryName = ""
            successMessage = NSLocalizedString(
                "admin_category_created",
                comment: "Report category created"
            )
            await loadReportCategories()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Delete a report category by ID.
    func deleteReportCategory(id: String) async {
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "DELETE",
                path: "/api/settings/report-types/\(id)"
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "admin_category_deleted",
                comment: "Report category deleted"
            )
            await loadReportCategories()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Telephony Settings

    /// Load the configured telephony provider.
    ///
    /// `GET /api/settings/telephony-provider` — the path the server mounts, and
    /// the one the desktop client reads. The screen used to call
    /// `GET /api/settings/telephony`, which answers 404; there is no
    /// `/telephony` route and never has been.
    ///
    /// The response is `TelephonyProvider?`: the route answers a bare `null`
    /// when no provider has been configured yet, which is the empty form.
    func loadTelephonySettings() async {
        guard !isLoadingTelephony else { return }
        isLoadingTelephony = true
        errorMessage = nil

        do {
            let stored: TelephonyProvider? = try await apiService.request(
                method: "GET",
                path: "/api/settings/telephony-provider"
            )
            apply(stored)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingTelephony = false
    }

    /// Save the telephony provider.
    ///
    /// `POST /api/provider-setup/configure`, which is the only write path for a
    /// provider: `PATCH /api/settings/telephony-provider` exists but answers
    /// 400 `updateTelephonyProvider is deprecated — use POST
    /// /provider-setup/configure which encrypts credentials at rest`, so it is
    /// not an alternative. The credentials travel in the request's
    /// `credentials` map and the service encrypts them before storing.
    ///
    /// The route answers `{ ok: true }` rather than the stored provider, so the
    /// screen re-reads it and shows what the server actually holds — which for
    /// this screen is the only way to see that a credential was accepted.
    func saveTelephonySettings() async {
        isSavingTelephony = true
        errorMessage = nil
        successMessage = nil

        do {
            var credentials: [String: String] = [:]
            if !telephonyAccountSid.isEmpty { credentials["accountSid"] = telephonyAccountSid }
            if !telephonyAuthToken.isEmpty { credentials["authToken"] = telephonyAuthToken }

            let _: EmptyResponse = try await apiService.request(
                method: "POST",
                path: "/api/provider-setup/configure",
                body: ConfigureProviderRequest(
                    credentials: credentials.isEmpty ? nil : credentials,
                    hubID: nil,
                    phoneNumber: telephonyPhoneNumber.isEmpty ? nil : telephonyPhoneNumber,
                    provider: telephonyProvider
                )
            )

            let stored: TelephonyProvider? = try await apiService.request(
                method: "GET",
                path: "/api/settings/telephony-provider"
            )
            apply(stored)

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "admin_telephony_saved",
                comment: "Telephony settings saved"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isSavingTelephony = false
    }

    /// Adopt the server's copy of the provider configuration. `nil` means no
    /// provider is configured, which leaves the form at its empty state.
    private func apply(_ provider: TelephonyProvider?) {
        guard let provider else { return }
        telephonyProvider = provider.type
        telephonyAccountSid = provider.accountSid ?? ""
        telephonyAuthToken = provider.authToken ?? ""
        telephonyPhoneNumber = provider.phoneNumber ?? ""
    }

    // MARK: - Call Settings

    /// Load call settings from the API.
    func loadCallSettings() async {
        guard !isLoadingCallSettings else { return }
        isLoadingCallSettings = true
        errorMessage = nil

        do {
            let settings: CallSettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/call"
            )
            apply(settings)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingCallSettings = false
    }

    /// Save call settings to the API.
    ///
    /// `PATCH`, which is the only write method the server mounts on this path
    /// (`settings.patch('/call', ...)`); the `PUT` this used to send answered
    /// 404, so no call setting entered from iOS was ever stored.
    ///
    /// The route answers with the stored settings after its own 30...300 clamp,
    /// so the response is applied back onto the sliders: what the screen shows
    /// afterwards is what the server actually holds, not what was requested.
    func saveCallSettings() async {
        isSavingCallSettings = true
        errorMessage = nil
        successMessage = nil

        do {
            let stored: CallSettings = try await apiService.request(
                method: "PATCH",
                path: "/api/settings/call",
                body: CallSettings(
                    queueTimeoutSeconds: queueTimeoutSeconds,
                    // nil is omitted from the PATCH body: this screen edits the two
                    // timeouts only and must leave the hub's recording opt-in as it is.
                    recordCalls: nil,
                    voicemailMaxSeconds: voicemailMaxSeconds
                )
            )
            apply(stored)

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "admin_call_settings_saved",
                comment: "Call settings saved"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isSavingCallSettings = false
    }

    /// Adopt a server copy of the call settings, keeping the current value for
    /// any field the server has not stored.
    private func apply(_ settings: CallSettings) {
        queueTimeoutSeconds = settings.queueTimeoutSeconds ?? queueTimeoutSeconds
        voicemailMaxSeconds = settings.voicemailMaxSeconds ?? voicemailMaxSeconds
    }

    // MARK: - IVR Languages

    /// Load the hub's IVR languages.
    ///
    /// There is deliberately no local default on failure. The screen used to
    /// invent `{en, es}` whenever the load threw, so an admin looked at a list
    /// that said two languages were enabled while the server held ten — and
    /// saving from that view would have disabled the other eight.
    func loadIvrLanguages() async {
        guard !isLoadingIvrLanguages else { return }
        isLoadingIvrLanguages = true
        errorMessage = nil

        do {
            let stored: IvrLanguages = try await apiService.request(
                method: "GET",
                path: "/api/settings/ivr-languages"
            )
            ivrEnabledLanguages = stored.enabledLanguages
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingIvrLanguages = false
    }

    /// Enable or disable one IVR language.
    ///
    /// Enabling appends, so a newly enabled language takes the last keypad
    /// position instead of displacing the ones callers already know.
    func setIvrLanguage(_ code: String, enabled: Bool) {
        if enabled {
            guard !ivrEnabledLanguages.contains(code) else { return }
            ivrEnabledLanguages.append(code)
        } else {
            ivrEnabledLanguages.removeAll { $0 == code }
        }
    }

    /// Save the IVR languages.
    ///
    /// `PATCH`, the only write method on this path; the `PUT` this used to send
    /// answered 404. The route validates the list against the configured
    /// provider's voice catalog and answers with what it stored, so the
    /// response is applied back onto the toggles.
    func saveIvrLanguages() async {
        isSavingIvrLanguages = true
        errorMessage = nil
        successMessage = nil

        do {
            let stored: IvrLanguages = try await apiService.request(
                method: "PATCH",
                path: "/api/settings/ivr-languages",
                body: IvrLanguages(enabledLanguages: ivrEnabledLanguages)
            )
            ivrEnabledLanguages = stored.enabledLanguages

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "admin_ivr_saved",
                comment: "IVR language settings saved"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isSavingIvrLanguages = false
    }

    /// Every locale a caller can be offered, with the language's own name —
    /// the `code`/`label` pairs of `LANGUAGES` in `packages/i18n/languages.ts`,
    /// which is the source of truth for which locales exist, and the same set
    /// the desktop IVR section lists.
    ///
    /// It was a 13-entry list with English exonyms ("Chinese", "Haitian
    /// Creole"), so nine shipped locales were unreachable from this screen and
    /// the nine that were reachable were named in a language the speaker may
    /// not read. Android keeps the same list in `SUPPORTED_LANGUAGES`
    /// (`ui/settings/SettingsScreen.kt`); neither is generated yet, which is
    /// tracked separately — the server still rejects a code outside
    /// `LANGUAGE_CODES`, so a drift here cannot store a language that does not
    /// exist.
    static let supportedLanguages: [(code: String, name: String)] = [
        ("en", "English"),
        ("es", "Español"),
        ("zh", "中文"),
        ("tl", "Tagalog"),
        ("vi", "Tiếng Việt"),
        ("ar", "العربية"),
        ("fr", "Français"),
        ("ht", "Kreyòl Ayisyen"),
        ("ko", "한국어"),
        ("ru", "Русский"),
        ("hi", "हिन्दी"),
        ("pt", "Português"),
        ("de", "Deutsch"),
        ("uk", "Українська"),
        ("fa", "فارسی"),
        ("tr", "Türkçe"),
        ("ku", "Kurdî"),
        ("so", "Soomaali"),
        ("am", "አማርኛ"),
        ("my", "မြန်မာ"),
        ("quc", "K'iche'"),
        ("mix", "Tu'un savi"),
    ]

    // MARK: - Transcription Settings

    /// Load transcription settings from the API.
    func loadTranscriptionSettings() async {
        guard !isLoadingTranscription else { return }
        isLoadingTranscription = true
        errorMessage = nil

        do {
            let stored: TranscriptionSettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/transcription"
            )
            apply(stored)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingTranscription = false
    }

    /// Save transcription settings.
    ///
    /// `PATCH`, the only write method the server mounts on this path; the `PUT`
    /// this used to send answered 404, so no transcription setting entered from
    /// iOS has ever been stored. The route answers with the stored settings and
    /// they are applied back onto the toggles.
    func saveTranscriptionSettings() async {
        isSavingTranscription = true
        errorMessage = nil
        successMessage = nil

        do {
            let stored: TranscriptionSettings = try await apiService.request(
                method: "PATCH",
                path: "/api/settings/transcription",
                body: TranscriptionSettings(
                    allowUserOptOut: transcriptionAllowUserOptOut,
                    globalEnabled: transcriptionGlobalEnabled
                )
            )
            apply(stored)

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "admin_transcription_saved",
                comment: "Transcription settings saved"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isSavingTranscription = false
    }

    /// Adopt a server copy of the transcription settings, keeping the current
    /// value for any field the server did not send.
    private func apply(_ settings: TranscriptionSettings) {
        transcriptionGlobalEnabled = settings.globalEnabled ?? transcriptionGlobalEnabled
        transcriptionAllowUserOptOut = settings.allowUserOptOut ?? transcriptionAllowUserOptOut
    }

    // MARK: - Spam Settings

    /// Load spam settings from the API.
    func loadSpamSettings() async {
        guard !isLoadingSpamSettings else { return }
        isLoadingSpamSettings = true
        errorMessage = nil

        do {
            let stored: SpamSettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/spam"
            )
            apply(stored)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingSpamSettings = false
    }

    /// Save spam settings.
    ///
    /// `PATCH`, the only write method the server mounts on this path; the `PUT`
    /// this used to send answered 404. The route answers with the stored
    /// settings and they are applied back onto the controls.
    func saveSpamSettings() async {
        isSavingSpamSettings = true
        errorMessage = nil
        successMessage = nil

        do {
            let stored: SpamSettings = try await apiService.request(
                method: "PATCH",
                path: "/api/settings/spam",
                body: SpamSettings(
                    blockDurationMinutes: spamBlockDurationMinutes,
                    maxCallsPerMinute: spamMaxCallsPerMinute,
                    rateLimitEnabled: spamRateLimitEnabled,
                    voiceCAPTCHAEnabled: spamVoiceCaptchaEnabled
                )
            )
            apply(stored)

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "admin_spam_saved",
                comment: "Spam settings saved"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isSavingSpamSettings = false
    }

    /// Adopt a server copy of the spam settings, keeping the current value for
    /// any field the server did not send.
    private func apply(_ settings: SpamSettings) {
        spamVoiceCaptchaEnabled = settings.voiceCAPTCHAEnabled ?? spamVoiceCaptchaEnabled
        spamRateLimitEnabled = settings.rateLimitEnabled ?? spamRateLimitEnabled
        spamMaxCallsPerMinute = settings.maxCallsPerMinute ?? spamMaxCallsPerMinute
        spamBlockDurationMinutes = settings.blockDurationMinutes ?? spamBlockDurationMinutes
    }

    // MARK: - System Health

    /// Load system health data from the API.
    func loadSystemHealth() async {
        guard !isLoadingHealth else { return }
        isLoadingHealth = true
        errorMessage = nil

        do {
            let health: SystemHealthResponse = try await apiService.request(
                method: "GET",
                path: "/api/system/health"
            )
            systemHealth = health
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingHealth = false
    }

    // MARK: - Erasure Queue

    /// Load erasure requests from the API.
    func loadErasureRequests() async {
        guard !isLoadingErasure else { return }
        isLoadingErasure = true
        errorMessage = nil

        do {
            var path = "/api/erasure/requests"
            if let filter = erasureStatusFilter {
                path += "?status=\(filter)"
            }
            let response: ErasureRequestListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            erasureRequests = response.requests.sorted {
                (DateFormatting.parseISO($0.requestedAt) ?? .distantPast)
                    > (DateFormatting.parseISO($1.requestedAt) ?? .distantPast)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingErasure = false
    }

    /// Execute immediate erasure for a user.
    func executeImmediateErasure(userId: String, justification: String) async {
        errorMessage = nil
        successMessage = nil

        do {
            let body = ImmediateErasureRequest(justification: justification)
            try await apiService.request(
                method: "POST",
                path: "/api/erasure/\(userId)",
                body: body
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            immediateErasureTargetId = nil
            immediateErasureJustification = ""
            showImmediateErasureDialog = false
            successMessage = NSLocalizedString("erasure_status_completed", comment: "Erasure completed")
            await loadErasureRequests()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Trigger remote device wipe for a specific device.
    func remoteWipeDevice(userId: String, devicePubkey: String) async {
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "POST",
                path: "/api/erasure/\(userId)/wipe-device/\(devicePubkey)"
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("device_wipe_wipe_complete", comment: "Device wipe sent")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Retention Settings

    /// Load retention settings from the API.
    func loadRetentionSettings() async {
        guard !isLoadingRetention else { return }
        isLoadingRetention = true
        errorMessage = nil

        do {
            let response: AppRetentionSettingsResponse = try await apiService.request(
                method: "GET",
                path: "/api/retention"
            )
            retentionSettings = response.categories
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingRetention = false
    }

    /// Save retention settings to the API.
    func saveRetentionSettings() async {
        isSavingRetention = true
        errorMessage = nil
        successMessage = nil

        do {
            let body = UpdateRetentionRequest(categories: retentionSettings)
            try await apiService.request(
                method: "PATCH",
                path: "/api/retention",
                body: body
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("retention_saved", comment: "Retention settings saved")
        } catch {
            errorMessage = error.localizedDescription
        }

        isSavingRetention = false
    }

    // MARK: - Platform Bans

    /// Load platform-scoped bans.
    func loadPlatformBans() async {
        guard !isLoadingPlatformBans else { return }
        isLoadingPlatformBans = true
        errorMessage = nil

        do {
            let response: PlatformBanListResponse = try await apiService.request(
                method: "GET",
                path: "/api/bans/platform"
            )
            platformBans = response.bans.sorted {
                ($0.bannedDate ?? Date.distantPast) > ($1.bannedDate ?? Date.distantPast)
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingPlatformBans = false
    }

    /// Create a platform-scoped ban.
    func addPlatformBan() async {
        let hash = newBanIdentifierHash.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hash.isEmpty else {
            errorMessage = NSLocalizedString("admin_ban_hash_required", comment: "Identifier hash is required")
            return
        }

        errorMessage = nil
        successMessage = nil

        do {
            let reason = newBanReason.trimmingCharacters(in: .whitespacesAndNewlines)
            let request = CreateBanRequest(
                identifierHash: hash,
                reason: reason.isEmpty ? nil : reason
            )
            try await apiService.request(
                method: "POST",
                path: "/api/bans/platform",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            newBanIdentifierHash = ""
            newBanReason = ""
            showAddPlatformBanSheet = false
            successMessage = NSLocalizedString("admin_ban_added", comment: "Ban entry added")
            await loadPlatformBans()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Remove a platform-scoped ban.
    func removePlatformBan(id: String) async {
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "DELETE",
                path: "/api/bans/platform/\(id)"
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("admin_ban_removed", comment: "Ban entry removed")
            await loadPlatformBans()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Search bans across all hubs by phone hash.
    func searchPlatformBans() async {
        let query = platformBanSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }

        errorMessage = nil

        do {
            let response: SearchBansResponse = try await apiService.request(
                method: "GET",
                path: "/api/bans/platform/search?q=\(query)"
            )
            platformBanSearchResults = response.bans
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Promote a hub-scoped ban to platform scope.
    ///
    /// `POST /api/bans/platform/promote` needs the number again: a hub's ban hash is
    /// keyed to that hub (`apps/worker/lib/crypto.ts` `banHash`), so the server cannot
    /// re-key it to the platform list on its own. It checks the number against the
    /// hub ban before adding the platform ban. Body is the generated `PromoteBanBody`.
    ///
    /// `GET /api/bans` does not return a ban `id`, so the id comes from a platform
    /// search result for the number the caller just typed (`SearchBansResponseBan`),
    /// and the same number is passed here. Covered by `AdminViewModelPromoteBanTests`.
    func promoteBanToPlatform(banId: String, phone: String) async {
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "POST",
                path: "/api/bans/platform/promote",
                wireBody: PromoteBanBody(banID: banId, phone: phone)
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("platform_bans_promote_button", comment: "Promoted to platform ban")
            await loadPlatformBans()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Deletion Confirmation

    /// Request confirmation for a destructive action.
    func confirmDelete(id: String, type: DeleteType) {
        pendingDeleteId = id
        pendingDeleteType = type
        showDeleteConfirmation = true
    }

    /// Execute the confirmed deletion.
    func executeDelete() async {
        guard let id = pendingDeleteId, let type = pendingDeleteType else { return }

        switch type {
        case .ban:
            await removeBan(id: id)
        case .reportCategory:
            await deleteReportCategory(id: id)
        case .erasure:
            break // Handled separately
        }

        pendingDeleteId = nil
        pendingDeleteType = nil
        showDeleteConfirmation = false
    }

    /// Cancel the pending deletion.
    func cancelDelete() {
        pendingDeleteId = nil
        pendingDeleteType = nil
        showDeleteConfirmation = false
    }
}

// MARK: - DeleteType

/// Types of items that can be deleted in the admin section.
enum DeleteType: Sendable {
    case ban
    case reportCategory
    case erasure
}

// MARK: - Erasure Models
// Erasure requests decode to generated `SharedRequest`; the queue response is
// generated `ErasureRequestListResponse`
// (packages/protocol/schemas/erasure.ts).

extension SharedRequest: Identifiable {}

struct ImmediateErasureRequest: Codable, Sendable {
    let justification: String
}

// MARK: - Retention Models

struct AppRetentionCategory: Codable, Identifiable, Sendable {
    var id: String { category }
    let category: String
    var retentionDays: Int?
    let minRetentionDays: Int?

    var categoryDisplay: String {
        switch category {
        case "call_records": return NSLocalizedString("retention_category_call_records", comment: "Call Records")
        case "notes": return NSLocalizedString("retention_category_notes", comment: "Notes")
        case "messages": return NSLocalizedString("retention_category_messages", comment: "Messages")
        case "audit_log": return NSLocalizedString("retention_category_audit_log", comment: "Audit Log")
        default: return category
        }
    }
}

struct AppRetentionSettingsResponse: Codable, Sendable {
    let categories: [AppRetentionCategory]
}

struct UpdateRetentionRequest: Codable, Sendable {
    let categories: [AppRetentionCategory]
}
