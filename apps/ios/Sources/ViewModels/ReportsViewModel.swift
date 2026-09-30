import Foundation
import UIKit

// MARK: - ReportsViewModel

/// View model for the Reports feature. Fetches reports from the API,
/// manages status filtering, and handles report creation with E2EE encryption.
/// Supports both legacy category-based reports and template-driven typed reports.
@Observable
final class ReportsViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService
    var adminPubkeys: [String]

    // MARK: - Public State

    /// Reports from the server.
    var reports: [ClientReportResponse] = []

    /// Available report categories from the server.
    var categories: [String] = []

    /// Report type definitions fetched from CMS settings.
    /// Populated from `GET /api/settings/cms/report-types` (preferred) with fallback
    /// to `GET /api/reports/types` (legacy).
    var reportTypes: [ClientReportTypeDefinition] = []

    /// CMS report types fetched directly from the settings endpoint.
    /// Includes full CMS-specific fields (hubId, isSystem, numberingEnabled, etc.).
    var cmsReportTypes: [ClientReportTypeDefinition] = []

    /// Current status filter.
    var selectedFilter: ReportStatusFilter = .all

    /// Selected report type filter (nil = all types).
    var selectedTypeFilter: String?

    /// Whether the initial load is in progress.
    var isLoading: Bool = false

    /// Whether a report action (create, claim, close) is in progress.
    var isActionInProgress: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Whether the report creation sheet is shown.
    var showCreateSheet: Bool = false

    /// Whether the report type picker is shown.
    var showReportTypePicker: Bool = false

    /// Total report count from server.
    var totalCount: Int = 0

    /// Reports filtered by the selected status filter and optional type filter.
    var filteredReports: [ClientReportResponse] {
        var result = reports
        if selectedFilter != .all {
            result = result.filter { $0.status == selectedFilter.rawValue }
        }
        if let typeFilter = selectedTypeFilter {
            result = result.filter { $0.reportTypeId == typeFilter }
        }
        return result
    }

    /// Mobile-optimized, non-archived report types available for submission.
    var mobileReportTypes: [ClientReportTypeDefinition] {
        reportTypes.filter { $0.mobileOptimized && !$0.isArchived }
    }

    /// Whether typed report creation is available (at least one mobile-optimized type exists).
    var hasTypedReports: Bool {
        !mobileReportTypes.isEmpty
    }

    /// Resolve a report type label from its ID.
    func reportTypeLabel(for typeId: String?) -> String? {
        guard let typeId else { return nil }
        return reportTypes.first { $0.id == typeId }?.label
    }

    // MARK: - Initialization

    init(apiService: APIService, cryptoService: CryptoService, adminPubkeys: [String] = []) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.adminPubkeys = adminPubkeys
    }

    // MARK: - Data Loading

    /// Load reports, categories, and report types from the API.
    /// Fetches CMS report types first (preferred), falling back to legacy endpoint.
    func loadReports() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        async let reportsResult: Void = fetchReports()
        async let categoriesResult: Void = fetchCategories()
        async let typesResult: Void = fetchReportTypes()
        async let cmsTypesResult: Void = loadCmsReportTypes()

        await reportsResult
        await categoriesResult
        await typesResult
        await cmsTypesResult

        // Prefer CMS report types over legacy if available
        if !cmsReportTypes.isEmpty {
            reportTypes = cmsReportTypes
        }

        isLoading = false
    }

    /// Load CMS report type definitions from `GET /api/settings/cms/report-types`.
    /// This endpoint returns full definitions with CMS-specific fields.
    func loadCmsReportTypes() async {
        do {
            let types = try await apiService.fetchCmsReportTypes()
            cmsReportTypes = types
        } catch {
            // CMS endpoint may not be available — fall back to legacy types
            cmsReportTypes = []
        }
    }

    /// Refresh reports (pull-to-refresh).
    func refresh() async {
        isLoading = false
        await loadReports()
    }

    // MARK: - Report Creation (Legacy)

    /// Encrypt and create a new report (legacy category-based).
    ///
    /// - Parameters:
    ///   - title: The report title.
    ///   - category: Optional report category.
    ///   - body: The report body text.
    /// - Returns: `true` if creation succeeded.
    @discardableResult
    func createReport(title: String, category: String?, body: String) async -> Bool {
        isActionInProgress = true
        errorMessage = nil

        do {
            // Encrypt the body with HPKE envelope encryption (same pattern as notes)
            var recipientPubkeys: [String] = []
            if let ourPubkey = cryptoService.encryptionPubkeyHex {
                recipientPubkeys.append(ourPubkey)
            }
            for adminPubkey in adminPubkeys where !recipientPubkeys.contains(adminPubkey) {
                recipientPubkeys.append(adminPubkey)
            }

            let result = try cryptoService.encryptNote(payload: body, recipientPubkeys: recipientPubkeys)

            guard let ourPubkey = cryptoService.encryptionPubkeyHex,
                  let ours = result.envelopes.first(where: { $0.pubkey == ourPubkey }) else {
                throw CryptoServiceError.noKeyLoaded
            }
            let authorEnvelope = ProtocolKeyEnvelope(
                ct: ours.envelope.ct,
                enc: ours.envelope.enc
            )

            let request = CreateReportRequest(
                title: title,
                category: category,
                encryptedContent: result.ciphertextHex,
                authorEnvelope: authorEnvelope,
                adminEnvelopes: result.envelopes
                    .filter { $0.pubkey != ourPubkey }
                    .map { env in
                        RecipientEnvelope(
                            ct: env.envelope.ct,
                            enc: env.envelope.enc,
                            pubkey: env.pubkey
                        )
                    }
            )

            let _: ClientReportResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/reports"),
                body: request
            )

            // Haptic feedback on success
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()

            // Reload reports to include the new one
            await refresh()
            isActionInProgress = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isActionInProgress = false
            return false
        }
    }

    // MARK: - Typed Report Creation

    /// Encrypt and create a template-driven typed report.
    ///
    /// Field values are serialized as JSON, encrypted as a single E2EE payload,
    /// and sent with the `reportTypeId` in metadata.
    ///
    /// - Parameters:
    ///   - reportTypeId: The report type definition ID.
    ///   - title: The report title (derived from type label or first text field).
    ///   - fieldValues: Dictionary of field name to value, serialized as JSON for encryption.
    /// - Returns: `true` if creation succeeded.
    @discardableResult
    func createTypedReport(reportTypeId: String, title: String, fieldValues: [String: AnyCodableValue]) async -> Bool {
        isActionInProgress = true
        errorMessage = nil

        do {
            // Serialize field values as JSON for encryption
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let fieldsData = try encoder.encode(fieldValues)
            let fieldsJSON = String(data: fieldsData, encoding: .utf8) ?? "{}"

            // Encrypt the fields JSON with per-message forward secrecy
            let encrypted = try cryptoService.encryptMessage(
                plaintext: fieldsJSON,
                readerPubkeys: adminPubkeys
            )

            let body = CreateTypedReportRequest(
                title: title,
                category: nil,
                reportTypeId: reportTypeId,
                encryptedContent: encrypted.encryptedContent,
                readerEnvelopes: encrypted.envelopes
            )

            let _: ClientReportResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/reports"),
                body: body
            )

            // Haptic feedback on success
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()

            // Reload reports to include the new one
            await refresh()
            isActionInProgress = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isActionInProgress = false
            return false
        }
    }

    // MARK: - Report Actions

    /// Claim a waiting report by assigning it to the current user.
    func claimReport(id: String) async {
        guard let signingPubkey = cryptoService.signingPubkeyHex else { return }
        isActionInProgress = true
        errorMessage = nil

        do {
            let request = ReportAssignRequest(assignTo: signingPubkey)
            let _: ClientReportResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/reports/\(id)/assign"),
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }

        isActionInProgress = false
    }

    /// Close an active report.
    func closeReport(id: String) async {
        isActionInProgress = true
        errorMessage = nil

        do {
            let request = ReportUpdateRequest(status: "closed")
            let _: ClientReportResponse = try await apiService.request(
                method: "PATCH",
                path: apiService.hp("/api/reports/\(id)"),
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }

        isActionInProgress = false
    }

    // MARK: - Private Helpers

    private func fetchReports() async {
        do {
            let response: ReportsListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/reports") + "?limit=50"
            )
            reports = response.conversations
            totalCount = response.total
        } catch {
            if case APIError.noBaseURL = error {
                // Hub not configured — show empty state, no error
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func fetchCategories() async {
        do {
            let response: ReportCategoriesResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/reports/categories")
            )
            categories = response.categories
        } catch {
            // Categories are optional — silently continue without them
            categories = []
        }
    }

    private func fetchReportTypes() async {
        do {
            let response: ClientReportTypesResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/reports/types")
            )
            reportTypes = response.reportTypes
        } catch {
            // Report types are optional — hub may not have any configured
            reportTypes = []
        }
    }
}
