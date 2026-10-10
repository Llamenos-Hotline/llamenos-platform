import SwiftUI

// MARK: - ShiftRequestsView

/// Admin review queue for volunteer join/leave requests: approve adds the
/// volunteer to the shift roster (or its ring group), deny closes the request.
/// Parity with the desktop Requests tab (`src/client/routes/shifts.tsx`).
struct ShiftRequestsView: View {
    @Bindable var viewModel: ShiftAdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.brand(.footnote))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("requests-error")
            }

            if let success = viewModel.successMessage {
                Section {
                    Label(success, systemImage: "checkmark.circle.fill")
                        .font(.brand(.footnote))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("requests-success")
            }

            Section {
                if viewModel.isLoading && viewModel.requests.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("requests-loading")
                } else if viewModel.requests.isEmpty {
                    BrandEmptyState(
                        icon: "checkmark.shield",
                        title: NSLocalizedString("shifts_requests_empty", comment: "No pending requests"),
                        message: NSLocalizedString("shifts_requests_empty_subtitle", comment: "Empty state subtitle")
                    )
                    .accessibilityIdentifier("requests-empty-state")
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(viewModel.requests) { request in
                        requestRow(request)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("shifts_requests_title", comment: "Shift Requests"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("requests-list")
        .refreshable {
            await viewModel.loadRequests()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadRequests()
            await viewModel.loadShifts()
        }
    }

    // MARK: - Request Row

    private func requestRow(_ request: Request) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    BadgeView(
                        text: request.type == .join
                            ? NSLocalizedString("shifts_requests_type_join", comment: "Join request")
                            : NSLocalizedString("shifts_requests_type_leave", comment: "Leave request"),
                        color: request.type == .join ? .brandPrimary : .brandMutedForeground,
                        style: .subtle
                    )
                    BadgeView(
                        text: NSLocalizedString("shifts_requests_status_pending", comment: "Pending"),
                        color: .brandMutedForeground,
                        style: .outlined
                    )
                }

                Text(viewModel.shiftName(for: request.shiftID))
                    .font(.brand(.subheadline))
                    .foregroundStyle(Color.brandForeground)

                Text(request.userPubkey.truncatedHash(16, suffixLen: 8))
                    .font(.brandMono(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }

            Spacer()

            HStack(spacing: 8) {
                Button {
                    Task { await viewModel.reviewRequest(id: request.id, approve: true) }
                } label: {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.statusActive)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(NSLocalizedString("shifts_requests_approve", comment: "Approve"))
                .accessibilityIdentifier("request-approve-\(request.id)")

                Button {
                    Task { await viewModel.reviewRequest(id: request.id, approve: false) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.brandDestructive)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(NSLocalizedString("shifts_requests_reject", comment: "Reject"))
                .accessibilityIdentifier("request-reject-\(request.id)")
            }
        }
        .accessibilityIdentifier("request-row-\(request.id)")
    }
}
