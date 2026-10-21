import SwiftUI

/// Admin view for the erasure request queue. Lists pending, scheduled, and completed
/// erasure requests with filtering. Admins can execute immediate erasure with justification.
struct ErasureQueueView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        ZStack {
            if viewModel.isLoadingErasure && viewModel.erasureRequests.isEmpty {
                loadingState
            } else if viewModel.erasureRequests.isEmpty {
                emptyState
            } else {
                requestList
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button(NSLocalizedString("erasure_status_pending", comment: "Pending")) {
                        viewModel.erasureStatusFilter = "pending"
                        Task { await viewModel.loadErasureRequests() }
                    }
                    Button(NSLocalizedString("erasure_status_scheduled", comment: "Scheduled")) {
                        viewModel.erasureStatusFilter = "scheduled"
                        Task { await viewModel.loadErasureRequests() }
                    }
                    Button(NSLocalizedString("erasure_status_completed", comment: "Completed")) {
                        viewModel.erasureStatusFilter = "completed"
                        Task { await viewModel.loadErasureRequests() }
                    }
                    Divider()
                    Button(NSLocalizedString("a11y_clear_filters", comment: "Clear filters")) {
                        viewModel.erasureStatusFilter = nil
                        Task { await viewModel.loadErasureRequests() }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                        .font(.body)
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("erasure-filter-menu")
            }
        }
        .sheet(isPresented: $viewModel.showImmediateErasureDialog) {
            immediateErasureSheet
        }
        .refreshable {
            viewModel.isLoadingErasure = false
            await viewModel.loadErasureRequests()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadErasureRequests()
        }
    }

    // MARK: - Request List

    private var requestList: some View {
        List {
            ForEach(viewModel.erasureRequests) { request in
                ErasureRequestRow(request: request) {
                    viewModel.immediateErasureTargetId = request.userID
                    viewModel.showImmediateErasureDialog = true
                }
                .accessibilityIdentifier("erasure-row-\(request.id)")
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("erasure-queue-list")
    }

    // MARK: - Immediate Erasure Sheet

    private var immediateErasureSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Text(NSLocalizedString(
                        "erasure_admin_execute_description",
                        comment: "Permanently erase this user's account and all associated data immediately."
                    ))
                    .font(.brand(.body))
                    .foregroundStyle(.secondary)
                }

                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(NSLocalizedString("erasure_admin_justification_label", comment: "Justification (required)"))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        TextField(
                            NSLocalizedString("erasure_admin_justification_placeholder", comment: "Reason for immediate erasure"),
                            text: $viewModel.immediateErasureJustification,
                            axis: .vertical
                        )
                        .lineLimit(3...6)
                        .accessibilityIdentifier("erasure-justification-input")
                    }
                }

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                    }
                }
            }
            .navigationTitle(NSLocalizedString("erasure_admin_execute_title", comment: "Immediate Erasure"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        viewModel.immediateErasureJustification = ""
                        viewModel.showImmediateErasureDialog = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("erasure_admin_execute_button", comment: "Execute Erasure"), role: .destructive) {
                        guard let userId = viewModel.immediateErasureTargetId else { return }
                        Task {
                            await viewModel.executeImmediateErasure(
                                userId: userId,
                                justification: viewModel.immediateErasureJustification
                            )
                        }
                    }
                    .disabled(viewModel.immediateErasureJustification.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("submit-immediate-erasure")
                }
            }
        }
    }

    // MARK: - Empty / Loading

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("erasure_admin_queue_empty", comment: "No pending erasure requests"),
                systemImage: "person.crop.circle.badge.checkmark"
            )
        } description: {
            Text(NSLocalizedString("erasure_admin_queue_empty", comment: "No pending erasure requests"))
        }
        .accessibilityIdentifier("erasure-queue-empty")
    }

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("erasure_admin_queue_loading", comment: "Loading erasure requests..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - ErasureRequestRow

struct ErasureRequestRow: View {
    let request: SharedRequest
    let onExecute: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(request.userID.truncatedPubkey())
                    .font(.brandMono(.body))
                    .lineLimit(1)

                Spacer()

                StatusBadge(status: request.status.rawValue)
            }

            if let justification = request.justification, !justification.isEmpty {
                Text(justification)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 12) {
                if let date = DateFormatting.parseISO(request.requestedAt) {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.caption))
                        .foregroundStyle(.tertiary)
                }

                if request.emergencyOverride {
                    BadgeView(
                        text: NSLocalizedString("erasure_emergency_override_label", comment: "Emergency"),
                        icon: "bolt.fill",
                        color: .orange,
                        style: .subtle
                    )
                }
            }

            // Wire statuses: pending, executing, completed, failed, cancelled.
            if request.status == .pending {
                Button(NSLocalizedString("erasure_admin_execute_button", comment: "Execute Erasure"), role: .destructive) {
                    onExecute()
                }
                .font(.brand(.footnote))
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - StatusBadge

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(statusText)
            .font(.brand(.caption))
            .foregroundStyle(statusColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.15))
            .clipShape(Capsule())
    }

    private var statusText: String {
        switch status {
        case "pending": return NSLocalizedString("erasure_status_pending", comment: "Pending")
        case "scheduled": return NSLocalizedString("erasure_status_scheduled", comment: "Scheduled")
        case "executing": return NSLocalizedString("erasure_status_executing", comment: "Executing")
        case "completed": return NSLocalizedString("erasure_status_completed", comment: "Completed")
        case "cancelled": return NSLocalizedString("erasure_status_cancelled", comment: "Cancelled")
        default: return status
        }
    }

    private var statusColor: Color {
        switch status {
        case "pending": return .orange
        case "scheduled": return .yellow
        case "executing": return .blue
        case "completed": return .green
        case "cancelled": return .secondary
        default: return .secondary
        }
    }
}
