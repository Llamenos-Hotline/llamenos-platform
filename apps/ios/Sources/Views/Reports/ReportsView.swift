import SwiftUI

// MARK: - ReportsView

/// Reports list view showing all reports with status filtering, pull-to-refresh,
/// type filtering (when typed reports are available), and creation via either the
/// legacy form or the template-driven report type picker.
struct ReportsView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<ReportsViewModel>()
    @State private var selectedReportType: ClientReportTypeDefinition?

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.reports.isEmpty {
                loadingState
            } else if let error = vm.errorMessage, vm.reports.isEmpty {
                errorState(error, vm: vm)
            } else if vm.filteredReports.isEmpty {
                emptyState(vm: vm)
            } else {
                reportsList(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("reports_title", comment: "Reports"))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 12) {
                    if vm.hasTypedReports {
                        typeFilterMenu(vm: vm)
                    }
                    filterMenu(vm: vm)
                    createButton(vm: vm)
                }
            }
        }
        // Legacy report creation sheet
        .sheet(isPresented: Binding(
            get: { vm.showCreateSheet },
            set: { vm.showCreateSheet = $0 }
        )) {
            ReportCreateView(
                categories: vm.categories,
                onSave: { title, category, body in
                    let success = await vm.createReport(
                        title: title,
                        category: category,
                        body: body
                    )
                    if success {
                        vm.showCreateSheet = false
                    }
                    return success
                }
            )
        }
        // Report type picker sheet
        .sheet(isPresented: Binding(
            get: { vm.showReportTypePicker },
            set: { vm.showReportTypePicker = $0 }
        )) {
            ReportTypePicker(
                reportTypes: vm.mobileReportTypes,
                onSelect: { reportType in
                    vm.showReportTypePicker = false
                    selectedReportType = reportType
                }
            )
        }
        // Typed report form sheet
        .sheet(item: $selectedReportType) { reportType in
            TypedReportCreateView(
                reportType: reportType,
                onSubmit: { title, fieldValues in
                    await vm.createTypedReport(
                        reportTypeId: reportType.id,
                        title: title,
                        fieldValues: fieldValues
                    )
                }
            )
        }
        .refreshable {
            await vm.refresh()
        }
        .task(id: hubContext.activeHubId) {
            await vm.loadReports()
        }
        .navigationDestination(for: String.self) { reportId in
            if let report = vm.reports.first(where: { $0.id == reportId }) {
                ReportDetailView(report: report, viewModel: vm)
            }
        }
    }

    // MARK: - Type Filter Menu

    @ViewBuilder
    private func typeFilterMenu(vm: ReportsViewModel) -> some View {
        Menu {
            Button {
                vm.selectedTypeFilter = nil
            } label: {
                if vm.selectedTypeFilter == nil {
                    Label(
                        NSLocalizedString("report_filter_all_types", comment: "All Types"),
                        systemImage: "checkmark"
                    )
                } else {
                    Text(NSLocalizedString("report_filter_all_types", comment: "All Types"))
                }
            }

            Divider()

            ForEach(vm.reportTypes.filter { !$0.isArchived }) { reportType in
                Button {
                    vm.selectedTypeFilter = reportType.id
                } label: {
                    if vm.selectedTypeFilter == reportType.id {
                        Label(reportType.label, systemImage: "checkmark")
                    } else {
                        Text(reportType.label)
                    }
                }
            }
        } label: {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.brand(.body))
                .symbolVariant(vm.selectedTypeFilter != nil ? .fill : .none)
        }
        .accessibilityIdentifier("reports-type-filter-button")
    }

    // MARK: - Filter Menu

    @ViewBuilder
    private func filterMenu(vm: ReportsViewModel) -> some View {
        Menu {
            ForEach(ReportStatusFilter.allCases, id: \.self) { filter in
                Button {
                    vm.selectedFilter = filter
                } label: {
                    if vm.selectedFilter == filter {
                        Label(filter.displayName, systemImage: "checkmark")
                    } else {
                        Text(filter.displayName)
                    }
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.brand(.body))
                .symbolVariant(vm.selectedFilter != .all ? .fill : .none)
        }
        .accessibilityIdentifier("reports-filter-button")
    }

    // MARK: - Create Button

    @ViewBuilder
    private func createButton(vm: ReportsViewModel) -> some View {
        if vm.hasTypedReports {
            // When typed reports are available, the primary action opens the type picker
            Button {
                vm.showReportTypePicker = true
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.brand(.body))
            }
            .accessibilityIdentifier("create-report-button")
            .accessibilityLabel(NSLocalizedString("reports_create", comment: "Create Report"))
        } else {
            // Legacy: direct to simple report creation
            Button {
                vm.showCreateSheet = true
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.brand(.body))
            }
            .accessibilityIdentifier("create-report-button")
            .accessibilityLabel(NSLocalizedString("reports_create", comment: "Create Report"))
        }
    }

    // MARK: - Reports List

    @ViewBuilder
    private func reportsList(vm: ReportsViewModel) -> some View {
        List {
            ForEach(vm.filteredReports) { report in
                NavigationLink(value: report.id) {
                    ReportRowView(
                        report: report,
                        reportTypeLabel: vm.reportTypeLabel(for: report.reportTypeId)
                    )
                }
                .accessibilityIdentifier("report-row-\(report.id)")
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("reports-list")
    }

    // MARK: - Empty State

    @ViewBuilder
    private func emptyState(vm: ReportsViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("reports_empty_title", comment: "No Reports"),
                systemImage: "doc.text"
            )
        } description: {
            if vm.selectedFilter != .all {
                Text(String(
                    format: NSLocalizedString(
                        "reports_empty_filtered",
                        comment: "No %@ reports found."
                    ),
                    vm.selectedFilter.displayName.lowercased()
                ))
            } else {
                Text(NSLocalizedString(
                    "reports_empty_message",
                    comment: "Reports you create will appear here."
                ))
            }
        } actions: {
            if vm.selectedFilter == .all {
                if vm.hasTypedReports {
                    Button {
                        vm.showReportTypePicker = true
                    } label: {
                        Text(NSLocalizedString("reports_create_first", comment: "Create First Report"))
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("create-first-report")
                } else {
                    Button {
                        vm.showCreateSheet = true
                    } label: {
                        Text(NSLocalizedString("reports_create_first", comment: "Create First Report"))
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("create-first-report")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reports-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("reports_loading", comment: "Loading reports..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reports-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: ReportsViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("reports_error_title", comment: "Unable to Load"),
                systemImage: "exclamationmark.triangle"
            )
        } description: {
            Text(error)
        } actions: {
            Button {
                Task { await vm.refresh() }
            } label: {
                Text(NSLocalizedString("retry", comment: "Retry"))
            }
            .buttonStyle(.bordered)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reports-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: ReportsViewModel {
        let currentAdminPubkeys = [appState.adminDecryptionPubkey].compactMap { $0 }
        if let vm = viewModelBox.value {
            vm.adminPubkeys = currentAdminPubkeys
            return vm
        }
        let vm = ReportsViewModel(apiService: appState.apiService, cryptoService: appState.cryptoService, adminPubkeys: currentAdminPubkeys)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - ReportRowView

/// A single report row in the list, showing title, status badge, category or type label, and date.
struct ReportRowView: View {
    let report: ClientReportResponse
    var reportTypeLabel: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Title
            Text(report.reportTitle)
                .font(.brand(.body))
                .fontWeight(.medium)
                .lineLimit(2)
                .foregroundStyle(.primary)

            // Metadata row
            HStack(spacing: 10) {
                // Status badge
                statusBadge(report.statusEnum)

                // Report type badge (if typed report)
                if let typeLabel = reportTypeLabel {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.text.fill")
                            .font(.brand(.caption))
                        Text(typeLabel)
                            .font(.brand(.caption))
                            .fontWeight(.medium)
                    }
                    .foregroundStyle(Color.brandPrimary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        Capsule().fill(Color.brandPrimary.opacity(0.12))
                    )
                    .accessibilityIdentifier("report-type-badge")
                }

                // Category badge (legacy reports)
                if reportTypeLabel == nil, let category = report.reportCategory {
                    HStack(spacing: 3) {
                        Image(systemName: "tag.fill")
                            .font(.brand(.caption))
                        Text(category)
                            .font(.brand(.caption))
                            .fontWeight(.medium)
                    }
                    .foregroundStyle(Color.brandDarkTeal)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        Capsule().fill(Color.brandDarkTeal.opacity(0.12))
                    )
                }

                Spacer()

                // Date
                if let date = DateFormatting.parseISO(report.createdAt) {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.footnote))
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func statusBadge(_ status: ReportStatus) -> some View {
        HStack(spacing: 3) {
            Image(systemName: status.icon)
                .font(.brand(.caption))
            Text(status.displayName)
                .font(.brand(.caption))
                .fontWeight(.medium)
        }
        .foregroundStyle(status.color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            Capsule().fill(status.color.opacity(0.12))
        )
    }

}

// MARK: - Preview

#if DEBUG
#Preview("Reports - Empty") {
    ReportsView()
        .environment(AppState(hubContext: HubContext()))
}
#endif
