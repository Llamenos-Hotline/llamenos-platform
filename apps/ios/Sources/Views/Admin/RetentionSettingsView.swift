import SwiftUI

/// Admin view for configuring per-hub data retention periods.
/// Each category (call records, notes, messages, audit log) can have an
/// independent retention period. Platform floors enforce minimums.
struct RetentionSettingsView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        Group {
            if viewModel.isLoadingRetention && viewModel.retentionSettings.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                settingsForm
            }
        }
        .navigationTitle(NSLocalizedString("retention_title", comment: "Data Retention"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(NSLocalizedString("action_save", comment: "Save")) {
                    Task { await viewModel.saveRetentionSettings() }
                }
                .fontWeight(.semibold)
                .disabled(viewModel.isSavingRetention)
                .accessibilityIdentifier("save-retention-button")
            }
        }
        .refreshable {
            viewModel.isLoadingRetention = false
            await viewModel.loadRetentionSettings()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadRetentionSettings()
        }
        .accessibilityIdentifier("retention-settings-view")
    }

    private var settingsForm: some View {
        Form {
            Section {
                Text(NSLocalizedString(
                    "retention_description",
                    comment: "Configure how long data is kept before automatic deletion"
                ))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
            }

            ForEach($viewModel.retentionSettings) { $category in
                AppRetentionCategoryRow(category: $category)
            }

            if let error = viewModel.errorMessage {
                Section {
                    Text(error)
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                }
            }

            if let success = viewModel.successMessage {
                Section {
                    Text(success)
                        .font(.brand(.footnote))
                        .foregroundStyle(.green)
                }
            }
        }
    }
}

// MARK: - AppRetentionCategoryRow

struct AppRetentionCategoryRow: View {
    @Binding var category: AppRetentionCategory

    @State private var isEnabled: Bool = false
    @State private var daysText: String = ""

    var body: some View {
        Section(header: Text(category.categoryDisplay)) {
            Toggle(
                NSLocalizedString("retention_enable_purge", comment: "Enable automatic purge"),
                isOn: $isEnabled
            )
            .onChange(of: isEnabled) { _, newValue in
                if !newValue {
                    category.retentionDays = nil
                } else {
                    category.retentionDays = category.minRetentionDays ?? 90
                    daysText = "\(category.retentionDays ?? 90)"
                }
            }

            if isEnabled {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString("retention_retention_days", comment: "Retention Period (days)"))
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)

                    TextField("90", text: $daysText)
                        .keyboardType(.numberPad)
                        .onChange(of: daysText) { _, newValue in
                            if let days = Int(newValue) {
                                category.retentionDays = max(days, category.minRetentionDays ?? 30)
                            }
                        }
                        .accessibilityIdentifier("retention-days-\(category.category)")
                }

                if let floor = category.minRetentionDays {
                    Text(L10n.format(
                        "retention_min_days",
                        comment: "Minimum: %d days (platform floor)",
                        floor
                    ))
                    .font(.brand(.caption))
                    .foregroundStyle(.orange)
                }
            }
        }
        .onAppear {
            isEnabled = category.retentionDays != nil
            if let days = category.retentionDays {
                daysText = "\(days)"
            }
        }
    }
}
