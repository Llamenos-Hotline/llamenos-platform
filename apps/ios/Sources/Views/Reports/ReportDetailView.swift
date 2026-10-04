import SwiftUI

// MARK: - ReportDetailView

/// Detail view for a single report. Shows title, status, category, metadata,
/// and action buttons (claim/close) for authorized users.
struct ReportDetailView: View {
    let report: SharedConversation
    let viewModel: ReportsViewModel

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var showCloseConfirmation: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Title
                Text(report.reportTitle)
                    .font(.brand(.title2))
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("report-title")

                // Status and category chips
                statusRow

                // Metadata card
                metadataCard

                // Action buttons
                actionButtons

                Spacer(minLength: 40)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
        .navigationTitle(NSLocalizedString("report_detail_title", comment: "Report"))
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            NSLocalizedString("report_close_confirm_title", comment: "Close Report"),
            isPresented: $showCloseConfirmation
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("report_close_confirm_action", comment: "Close"), role: .destructive) {
                Task {
                    await viewModel.closeReport(id: report.id)
                    dismiss()
                }
            }
        } message: {
            Text(NSLocalizedString(
                "report_close_confirm_message",
                comment: "Are you sure you want to close this report? This cannot be undone."
            ))
        }
        .accessibilityIdentifier("report-detail-view")
    }

    // MARK: - Status Row

    private var statusRow: some View {
        HStack(spacing: 10) {
            // Status badge
            HStack(spacing: 4) {
                Image(systemName: report.statusEnum.icon)
                    .font(.brand(.caption))
                Text(report.statusEnum.displayName)
                    .font(.brand(.caption))
                    .fontWeight(.semibold)
            }
            .foregroundStyle(report.statusEnum.color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(report.statusEnum.color.opacity(0.12))
            )
            .accessibilityIdentifier("report-status")

            // Report type badge (if typed report)
            if let typeLabel = viewModel.reportTypeLabel(for: report.reportTypeId) {
                HStack(spacing: 4) {
                    Image(systemName: "doc.text.fill")
                        .font(.brand(.caption))
                    Text(typeLabel)
                        .font(.brand(.caption))
                        .fontWeight(.semibold)
                }
                .foregroundStyle(Color.brandPrimary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(Color.brandPrimary.opacity(0.12))
                )
                .accessibilityIdentifier("report-type-badge")
            }

            // Category badge (legacy reports without a type)
            if report.reportTypeId == nil, let category = report.reportCategory {
                HStack(spacing: 4) {
                    Image(systemName: "tag.fill")
                        .font(.brand(.caption))
                    Text(category)
                        .font(.brand(.caption))
                        .fontWeight(.semibold)
                }
                .foregroundStyle(Color.brandDarkTeal)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(Color.brandDarkTeal.opacity(0.12))
                )
                .accessibilityIdentifier("report-category")
            }
        }
    }

    // MARK: - Metadata Card

    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(NSLocalizedString("report_detail_info", comment: "Info"))
                .font(.brand(.headline))

            LabeledContent {
                if let date = DateFormatting.parseISO(report.createdAt) {
                    Text(date.formatted(date: .long, time: .shortened))
                        .foregroundStyle(.primary)
                }
            } label: {
                Text(NSLocalizedString("report_detail_created", comment: "Created"))
                    .foregroundStyle(.secondary)
            }

            if let assignedTo = report.assignedTo {
                LabeledContent {
                    Text(assignedTo.truncatedPubkey())
                        .font(.brandMono(.body))
                        .foregroundStyle(.primary)
                } label: {
                    Text(NSLocalizedString("report_detail_assigned", comment: "Assigned To"))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("report-assigned-to")
            }

            LabeledContent {
                Text("\(report.messageCount)")
                    .foregroundStyle(.primary)
            } label: {
                Text(NSLocalizedString("report_detail_messages", comment: "Messages"))
                    .foregroundStyle(.secondary)
            }

            if let updatedAt = report.updatedAt, let date = DateFormatting.parseISO(updatedAt) {
                LabeledContent {
                    Text(date.formatted(date: .long, time: .shortened))
                        .foregroundStyle(.primary)
                } label: {
                    Text(NSLocalizedString("report_detail_updated", comment: "Updated"))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.brandCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.brandBorder, lineWidth: 1)
        )
        .accessibilityIdentifier("report-metadata")
    }

    // MARK: - Action Buttons

    @ViewBuilder
    private var actionButtons: some View {
        VStack(spacing: 12) {
            // Claim button — visible when report is waiting
            if report.statusEnum == .waiting {
                Button {
                    Task {
                        await viewModel.claimReport(id: report.id)
                        dismiss()
                    }
                } label: {
                    Label(
                        NSLocalizedString("report_claim", comment: "Claim Report"),
                        systemImage: "hand.raised.fill"
                    )
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.brandPrimary)
                .disabled(viewModel.isActionInProgress)
                .accessibilityIdentifier("report-claim-button")
            }

            // Close button — visible when report is active and user is admin
            if report.statusEnum == .active && appState.hasPermission("reports:update") {
                Button(role: .destructive) {
                    showCloseConfirmation = true
                } label: {
                    Label(
                        NSLocalizedString("report_close", comment: "Close Report"),
                        systemImage: "xmark.circle.fill"
                    )
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.brandDestructive)
                .disabled(viewModel.isActionInProgress)
                .accessibilityIdentifier("report-close-button")
            }
        }
        .padding(.horizontal, 4)
    }


}

// MARK: - Preview

#if DEBUG
#Preview("Report Detail") {
    NavigationStack {
        ReportDetailView(
            report: SharedConversation(
                assignedTo: nil,
                channelType: "reports",
                contactIdentifierHash: "hash",
                contactLast4: nil,
                createdAt: ISO8601DateFormatter().string(from: Date()),
                id: "preview-1",
                lastMessageAt: nil,
                messageCount: 0,
                metadata: Metadata(
                    conversionStatus: nil,
                    customFieldValues: nil,
                    linkedCallID: nil,
                    reportCategory: "Safety",
                    reportID: nil,
                    reportTitle: "Suspicious activity near shelter",
                    reportTypeID: nil,
                    type: .report
                ),
                status: .waiting,
                updatedAt: ISO8601DateFormatter().string(from: Date())
            ),
            viewModel: ReportsViewModel(
                apiService: APIService(cryptoService: CryptoService(), hubContext: HubContext()),
                cryptoService: CryptoService()
            )
        )
        .environment(AppState(hubContext: HubContext()))
    }
}
#endif
