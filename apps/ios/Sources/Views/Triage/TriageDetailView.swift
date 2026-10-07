import SwiftUI

// MARK: - TriageDetailView

/// Detail view for a triage report. Shows report content, metadata, and a
/// "Convert to Case" button that creates a new case record from the report.
struct TriageDetailView: View {
    let report: SharedConversation
    let viewModel: TriageViewModel

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var showConvertConfirmation: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Title
                Text(report.reportTitle)
                    .font(.brand(.title2))
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("triage-report-title")

                // Status and type chips
                statusRow

                // Metadata card
                metadataCard

                // Convert to case button
                if report.statusEnum != .closed {
                    convertButton
                }

                Spacer(minLength: 40)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
        .navigationTitle(NSLocalizedString("triage_detail_title", comment: "Triage Report"))
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            NSLocalizedString("triage_convert_confirm_title", comment: "Convert to Case"),
            isPresented: $showConvertConfirmation
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("triage_convert_confirm_action", comment: "Convert"), role: .none) {
                Task {
                    let success = await viewModel.convertToEntity(report: report, entityTypeId: "case")
                    if success {
                        dismiss()
                    }
                }
            }
        } message: {
            Text(NSLocalizedString(
                "triage_convert_confirm_message",
                comment: "This will create a new case record from this report. The report will be linked to the new case."
            ))
        }
        .accessibilityIdentifier("triage-detail-view")
    }

    // MARK: - Status Row

    private var statusRow: some View {
        HStack(spacing: 10) {
            // Report status badge
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
            .accessibilityIdentifier("triage-report-status")

            // Report type badge
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
                .accessibilityIdentifier("triage-report-type")
            }

            // Category badge (legacy)
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
            }
        }
    }

    // MARK: - Metadata Card

    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(NSLocalizedString("triage_detail_info", comment: "Report Info"))
                .font(.brand(.headline))

            LabeledContent {
                if let date = DateFormatting.parseISO(report.createdAt) {
                    Text(date.formatted(date: .long, time: .shortened))
                        .foregroundStyle(.primary)
                }
            } label: {
                Text(NSLocalizedString("triage_detail_created", comment: "Created"))
                    .foregroundStyle(.secondary)
            }

            if let assignedTo = report.assignedTo {
                LabeledContent {
                    Text(assignedTo.truncatedPubkey())
                        .font(.brandMono(.body))
                        .foregroundStyle(.primary)
                } label: {
                    Text(NSLocalizedString("triage_detail_assigned", comment: "Assigned To"))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("triage-assigned-to")
            }

            LabeledContent {
                Text("\(report.messageCount)")
                    .foregroundStyle(.primary)
            } label: {
                Text(NSLocalizedString("triage_detail_messages", comment: "Messages"))
                    .foregroundStyle(.secondary)
            }

            if let date = DateFormatting.parseISO(report.updatedAt) {
                LabeledContent {
                    Text(date.formatted(date: .long, time: .shortened))
                        .foregroundStyle(.primary)
                } label: {
                    Text(NSLocalizedString("triage_detail_updated", comment: "Updated"))
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
        .accessibilityIdentifier("triage-metadata")
    }

    // MARK: - Convert Button

    private var convertButton: some View {
        Button {
            showConvertConfirmation = true
        } label: {
            Label(
                NSLocalizedString("triage_convert_to_case", comment: "Convert to Case"),
                systemImage: "folder.badge.plus"
            )
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(.brandPrimary)
        .disabled(viewModel.isActionInProgress)
        .accessibilityIdentifier("triage-convert-button")
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Triage Detail") {
    NavigationStack {
        TriageDetailView(
            report: SharedConversation(
                assignedTo: nil,
                channelType: "reports",
                contactIdentifierHash: "hash",
                contactLast4: nil,
                createdAt: ISO8601DateFormatter().string(from: Date()),
                id: "preview-1",
                lastMessageAt: nil,
                messageCount: 2,
                metadata: Metadata(
                    conversionStatus: nil,
                    customFieldValues: nil,
                    linkedCallID: nil,
                    reportCategory: "Safety",
                    reportID: nil,
                    reportTitle: "Incident near downtown shelter",
                    reportTypeID: nil,
                    type: .report
                ),
                status: .waiting,
                updatedAt: ISO8601DateFormatter().string(from: Date())
            ),
            viewModel: TriageViewModel(
                apiService: APIService(cryptoService: CryptoService(), hubContext: HubContext()),
                cryptoService: CryptoService()
            )
        )
        .environment(AppState(hubContext: HubContext()))
    }
}
#endif
