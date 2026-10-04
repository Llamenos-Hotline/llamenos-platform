import Foundation

// MARK: - TriageStatus

/// Conversion status for triage reports.
enum TriageStatusFilter: String, CaseIterable, Sendable {
    case all
    case pending
    case reviewing
    case converted
    case dismissed
    case inProgress = "in_progress"
    case completed

    var displayName: String {
        switch self {
        case .all: return NSLocalizedString("triage_filter_all", comment: "All")
        case .pending: return NSLocalizedString("triage_status_pending", comment: "Pending")
        case .reviewing: return NSLocalizedString("triage_status_reviewing", comment: "Reviewing")
        case .converted: return NSLocalizedString("triage_status_converted", comment: "Converted")
        case .dismissed: return NSLocalizedString("triage_status_dismissed", comment: "Dismissed")
        case .inProgress: return NSLocalizedString("triage_filter_in_progress", comment: "In Progress")
        case .completed: return NSLocalizedString("triage_filter_completed", comment: "Completed")
        }
    }
}

// MARK: - TriageViewModel

/// Manages the triage queue: reports with `allowCaseConversion: true` that can be
/// converted to case records. Fetches from `GET /api/reports?conversionEnabled=true`.
@Observable
final class TriageViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService

    var reports: [SharedConversation] = []
    var total: Int = 0
    var isLoading = false
    var isActionInProgress = false
    var errorMessage: String?

    /// Current conversion status filter.
    var selectedFilter: TriageStatusFilter = .pending

    /// Filtered reports based on selected conversion status.
    var filteredReports: [SharedConversation] {
        guard selectedFilter != .all else { return reports }
        // The conversionStatus filter is applied server-side, but for client-side
        // filtering of already-loaded data:
        return reports
    }

    /// Report type definitions for resolving labels.
    var reportTypes: [CMSReportTypeListResponseReportType] = []

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    // MARK: - Load Triage Reports

    func loadReports() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        async let reportsResult: Void = fetchReports()
        async let typesResult: Void = fetchReportTypes()

        await reportsResult
        await typesResult

        isLoading = false
    }

    private func fetchReports() async {
        do {
            var path = apiService.hp("/api/reports") + "?conversionEnabled=true&limit=50"
            if selectedFilter != .all {
                path += "&conversionStatus=\(selectedFilter.rawValue)"
            }
            let response: ReportListResponse = try await apiService.request(
                method: "GET",
                path: path
            )
            reports = response.conversations
            total = Int(response.total)
        } catch {
            if reports.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func fetchReportTypes() async {
        do {
            let types = try await apiService.fetchCmsReportTypes()
            reportTypes = types
        } catch {
            // Report types are optional
        }
    }

    // MARK: - Filter

    func filterByStatus(_ status: TriageStatusFilter) async {
        selectedFilter = status
        reports = []
        total = 0
        await fetchReports()
    }

    // MARK: - Refresh

    func refresh() async {
        isLoading = false
        await loadReports()
    }

    // MARK: - Convert to Case

    /// Convert a triage report to a case record.
    ///
    /// Convert a triage report to a full entity record using the atomic conversion endpoint.
    ///
    /// - Parameters:
    ///   - report: The report to convert.
    ///   - entityTypeId: The target entity type ID selected by the user.
    /// - Returns: `true` if conversion succeeded.
    @discardableResult
    func convertToEntity(report: SharedConversation, entityTypeId: String) async -> Bool {
        isActionInProgress = true
        errorMessage = nil

        do {
            let body = AppConvertFromReportBody(
                reportId: report.id,
                entityTypeId: entityTypeId,
                additionalFields: nil
            )
            let _: AppConvertFromReportResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/records/convert-from-report"),
                body: body
            )
            await refresh()
            isActionInProgress = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isActionInProgress = false
            return false
        }
    }

    // MARK: - Helpers

    func reportTypeLabel(for typeId: String?) -> String? {
        guard let typeId else { return nil }
        return reportTypes.first { $0.id == typeId }?.label
    }
}

// MARK: - Request/Response Types

struct AppConvertFromReportBody: Encodable, Sendable {
    let reportId: String
    let entityTypeId: String
    let additionalFields: [String: String]?
}

struct AppConvertFromReportResponse: Codable, Sendable {
    let recordId: String
    let reportId: String
    let entityTypeId: String
    let caseNumber: String?
    let autoAssigned: Bool
    let assignedTo: [String]
}
