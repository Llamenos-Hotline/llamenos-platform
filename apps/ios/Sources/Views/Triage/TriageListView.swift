import SwiftUI

// MARK: - TriageListView

/// List of reports with `allowCaseConversion: true` that are pending triage.
/// Admins use this queue to review incoming reports and convert them to case records.
struct TriageListView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<TriageViewModel>()

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
                triageList(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("triage_title", comment: "Triage Queue"))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                filterMenu(vm: vm)
            }
        }
        .refreshable {
            await vm.refresh()
        }
        .task {
            await vm.loadReports()
        }
        .navigationDestination(for: String.self) { reportId in
            if let report = vm.reports.first(where: { $0.id == reportId }) {
                TriageDetailView(report: report, viewModel: vm)
            }
        }
    }

    // MARK: - Filter Menu

    @ViewBuilder
    private func filterMenu(vm: TriageViewModel) -> some View {
        Menu {
            ForEach(TriageStatusFilter.allCases, id: \.self) { filter in
                Button {
                    Task { await vm.filterByStatus(filter) }
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
                .symbolVariant(vm.selectedFilter != .pending ? .fill : .none)
        }
        .accessibilityIdentifier("triage-filter-button")
    }

    // MARK: - Triage List

    @ViewBuilder
    private func triageList(vm: TriageViewModel) -> some View {
        List {
            ForEach(vm.filteredReports) { report in
                NavigationLink(value: report.id) {
                    TriageRowView(
                        report: report,
                        reportTypeLabel: vm.reportTypeLabel(for: report.reportTypeId)
                    )
                }
                .accessibilityIdentifier("triage-row-\(report.id)")
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("triage-list")
    }

    // MARK: - Empty State

    @ViewBuilder
    private func emptyState(vm: TriageViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("triage_empty_title", comment: "No Reports to Triage"),
                systemImage: "tray"
            )
        } description: {
            if vm.selectedFilter != .all {
                Text(String(
                    format: NSLocalizedString(
                        "triage_empty_filtered",
                        comment: "No %@ reports in the triage queue."
                    ),
                    vm.selectedFilter.displayName.lowercased()
                ))
            } else {
                Text(NSLocalizedString(
                    "triage_empty_message",
                    comment: "Reports eligible for case conversion will appear here."
                ))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("triage-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("triage_loading", comment: "Loading triage queue..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("triage-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: TriageViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("triage_error_title", comment: "Unable to Load"),
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
        .accessibilityIdentifier("triage-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: TriageViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = TriageViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - TriageRowView

/// A single triage report row showing title, status, report type, and date.
struct TriageRowView: View {
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
                // Status chip
                conversionStatusChip(report.statusEnum)

                // Report type badge
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
                }

                // Category badge (legacy)
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
    private func conversionStatusChip(_ status: ReportStatus) -> some View {
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
