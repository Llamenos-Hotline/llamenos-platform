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
    var bans: [AppBanEntry] = []

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
    var auditEntries: [AppAuditEntry] = []

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
    var invites: [AppInvite] = []

    /// Whether invites are loading.
    var isLoadingInvites: Bool = false

    /// Whether the create invite sheet is showing.
    var showCreateInviteSheet: Bool = false

    /// Selected role for new invite.
    var newInviteRole: UserRole = .volunteer

    // MARK: - Custom Fields State

    /// All custom field definitions.
    var customFields: [CustomFieldDefinition] = []

    /// Whether custom fields are loading.
    var isLoadingFields: Bool = false

    /// Whether the field editor sheet is showing.
    var showFieldEditor: Bool = false

    /// The field being edited (nil for create).
    var editingField: CustomFieldDefinition?

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

    /// Current telephony configuration.
    var telephonySettings: TelephonySettings = TelephonySettings(
        provider: "twilio", accountSid: "", authToken: "", phoneNumber: ""
    )

    /// Whether telephony settings are loading.
    var isLoadingTelephony: Bool = false

    /// Whether telephony settings are being saved.
    var isSavingTelephony: Bool = false

    // MARK: - Call Settings State

    /// Current call routing configuration.
    var callSettings: ClientCallSettings = ClientCallSettings(
        ringTimeout: 30, maxDuration: 60, parallelRingCount: 5
    )

    /// Whether call settings are loading.
    var isLoadingCallSettings: Bool = false

    /// Whether call settings are being saved.
    var isSavingCallSettings: Bool = false

    // MARK: - IVR Languages State

    /// Current IVR language configuration (language code → enabled).
    var ivrLanguages: [String: Bool] = [:]

    /// Whether IVR languages are loading.
    var isLoadingIvrLanguages: Bool = false

    /// Whether IVR languages are being saved.
    var isSavingIvrLanguages: Bool = false

    // MARK: - Transcription Settings State

    /// Current transcription configuration.
    var transcriptionSettings: ClientTranscriptionSettings = ClientTranscriptionSettings(
        enabled: false, allowVolunteerOptOut: false
    )

    /// Whether transcription settings are loading.
    var isLoadingTranscription: Bool = false

    /// Whether transcription settings are being saved.
    var isSavingTranscription: Bool = false

    // MARK: - Spam Settings State

    /// Current spam mitigation configuration.
    var spamSettings: ClientSpamSettings = ClientSpamSettings(
        maxCallsPerHour: 10, voiceCaptchaEnabled: false, knownNumberBypass: false
    )

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
    var erasureRequests: [AdminErasureRequest] = []

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
    var platformBans: [AppBanEntry] = []

    /// Whether platform bans are loading.
    var isLoadingPlatformBans: Bool = false

    /// Whether the add platform ban sheet is showing.
    var showAddPlatformBanSheet: Bool = false

    /// Search query for cross-hub ban search.
    var platformBanSearchQuery: String = ""

    /// Search results from cross-hub search.
    var platformBanSearchResults: [AppBanEntry] = []

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
            let request = UpdateRoleRequest(role: newRole.rawValue)
            try await apiService.request(
                method: "PATCH",
                path: "/api/identity/\(pubkey)/role",
                body: request
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
            let response: AppBanListResponse = try await apiService.request(
                method: "GET",
                path: "/api/bans"
            )
            bans = response.bans.sorted { lhs, rhs in
                (lhs.createdDate ?? Date.distantPast) > (rhs.createdDate ?? Date.distantPast)
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
            let response: AuditLogResponse = try await apiService.request(
                method: "GET",
                path: "/api/audit?page=1&limit=\(auditPageSize)"
            )
            auditEntries = response.entries
            auditTotal = response.total
            hasMoreAudit = auditEntries.count < response.total
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
            let response: AuditLogResponse = try await apiService.request(
                method: "GET",
                path: "/api/audit?page=\(nextPage)&limit=\(auditPageSize)"
            )
            auditEntries.append(contentsOf: response.entries)
            auditPage = nextPage
            auditTotal = response.total
            hasMoreAudit = auditEntries.count < response.total
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
            let response: InvitesListResponse = try await apiService.request(
                method: "GET",
                path: "/api/identity/invites"
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
            let request = CreateInviteRequest(role: newInviteRole.rawValue)
            let _: AppInvite = try await apiService.request(
                method: "POST",
                path: "/api/identity/invite",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            showCreateInviteSheet = false
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
            let response: CustomFieldsResponse = try await apiService.request(
                method: "GET",
                path: "/api/settings/custom-fields?role=admin"
            )
            customFields = response.fields.sorted { $0.order < $1.order }
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
            let body = ["fields": customFields]
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
    func saveField(_ field: CustomFieldDefinition) async {
        if let index = customFields.firstIndex(where: { $0.id == field.id }) {
            customFields[index] = field
        } else {
            customFields.append(field)
        }
        await saveCustomFields()
        showFieldEditor = false
        editingField = nil
    }

    /// Delete a field by ID, then save to server.
    func deleteField(id: String) async {
        customFields.removeAll { $0.id == id }
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

    /// Load telephony settings from the API.
    func loadTelephonySettings() async {
        guard !isLoadingTelephony else { return }
        isLoadingTelephony = true
        errorMessage = nil

        do {
            let settings: TelephonySettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/telephony"
            )
            telephonySettings = settings
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingTelephony = false
    }

    /// Save telephony settings to the API.
    func saveTelephonySettings() async {
        isSavingTelephony = true
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "PUT",
                path: "/api/settings/telephony",
                body: telephonySettings
            )

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

    // MARK: - Call Settings

    /// Load call settings from the API.
    func loadCallSettings() async {
        guard !isLoadingCallSettings else { return }
        isLoadingCallSettings = true
        errorMessage = nil

        do {
            let settings: ClientCallSettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/call"
            )
            callSettings = settings
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingCallSettings = false
    }

    /// Save call settings to the API.
    func saveCallSettings() async {
        isSavingCallSettings = true
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "PUT",
                path: "/api/settings/call",
                body: callSettings
            )

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

    // MARK: - IVR Languages

    /// Load IVR language settings from the API.
    func loadIvrLanguages() async {
        guard !isLoadingIvrLanguages else { return }
        isLoadingIvrLanguages = true
        errorMessage = nil

        do {
            let response: ClientIvrLanguages = try await apiService.request(
                method: "GET",
                path: "/api/settings/ivr-languages"
            )
            ivrLanguages = response.languages
        } catch {
            // Initialize with defaults if endpoint returns no data
            if ivrLanguages.isEmpty {
                for code in Self.supportedLanguages.map(\.code) {
                    ivrLanguages[code] = code == "en" || code == "es"
                }
            }
            errorMessage = error.localizedDescription
        }

        isLoadingIvrLanguages = false
    }

    /// Save IVR language settings to the API.
    func saveIvrLanguages() async {
        isSavingIvrLanguages = true
        errorMessage = nil
        successMessage = nil

        do {
            let body = ClientIvrLanguages(languages: ivrLanguages)
            try await apiService.request(
                method: "PUT",
                path: "/api/settings/ivr-languages",
                body: body
            )

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

    /// Supported IVR languages with display names.
    static let supportedLanguages: [(code: String, name: String)] = [
        ("en", "English"),
        ("es", "Spanish"),
        ("zh", "Chinese"),
        ("tl", "Tagalog"),
        ("vi", "Vietnamese"),
        ("ar", "Arabic"),
        ("fr", "French"),
        ("ht", "Haitian Creole"),
        ("ko", "Korean"),
        ("ru", "Russian"),
        ("hi", "Hindi"),
        ("pt", "Portuguese"),
        ("de", "German"),
    ]

    // MARK: - Transcription Settings

    /// Load transcription settings from the API.
    func loadTranscriptionSettings() async {
        guard !isLoadingTranscription else { return }
        isLoadingTranscription = true
        errorMessage = nil

        do {
            let settings: ClientTranscriptionSettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/transcription"
            )
            transcriptionSettings = settings
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingTranscription = false
    }

    /// Save transcription settings to the API.
    func saveTranscriptionSettings() async {
        isSavingTranscription = true
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "PUT",
                path: "/api/settings/transcription",
                body: transcriptionSettings
            )

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

    // MARK: - Spam Settings

    /// Load spam settings from the API.
    func loadSpamSettings() async {
        guard !isLoadingSpamSettings else { return }
        isLoadingSpamSettings = true
        errorMessage = nil

        do {
            let settings: ClientSpamSettings = try await apiService.request(
                method: "GET",
                path: "/api/settings/spam"
            )
            spamSettings = settings
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingSpamSettings = false
    }

    /// Save spam settings to the API.
    func saveSpamSettings() async {
        isSavingSpamSettings = true
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "PUT",
                path: "/api/settings/spam",
                body: spamSettings
            )

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
            let response: ErasureQueueResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            erasureRequests = response.requests.sorted {
                ($0.requestedAt ?? Date.distantPast) > ($1.requestedAt ?? Date.distantPast)
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
            let response: AppBanListResponse = try await apiService.request(
                method: "GET",
                path: "/api/bans/platform"
            )
            platformBans = response.bans.sorted {
                ($0.createdDate ?? Date.distantPast) > ($1.createdDate ?? Date.distantPast)
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
            let response: AppBanListResponse = try await apiService.request(
                method: "GET",
                path: "/api/bans/platform/search?q=\(query)"
            )
            platformBanSearchResults = response.bans
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Promote a hub-scoped ban to platform scope.
    func promoteBanToPlatform(banId: String) async {
        errorMessage = nil
        successMessage = nil

        guard let ban = bans.first(where: { $0.id == banId }) else { return }

        do {
            let request = CreateBanRequest(
                identifierHash: ban.identifierHash,
                reason: ban.reason
            )
            try await apiService.request(
                method: "POST",
                path: "/api/bans/platform",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString("platform_bans_promote_button", comment: "Promoted to platform ban")
            await loadPlatformBans()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Recording URL

    /// Build a streaming URL for a recording.
    func recordingStreamURL(recordingId: String) -> URL? {
        guard let baseURL = apiService.baseURL else { return nil }
        return baseURL.appendingPathComponent("/api/recordings/\(recordingId)/stream")
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

struct AdminErasureRequest: Codable, Identifiable, Sendable {
    let id: String
    let userId: String
    let status: String
    let requestedAt: Date?
    let executeAt: Date?
    let requestedBy: String?
    let justification: String?
    let emergencyOverride: Bool?
}

struct ErasureQueueResponse: Codable, Sendable {
    let requests: [AdminErasureRequest]
}

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
