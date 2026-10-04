import SwiftUI

// MARK: - CallSettingsView

/// Admin view for configuring call routing parameters: ring timeout, max call
/// duration, and parallel ring count.
struct CallSettingsView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        Form {
            if viewModel.isLoadingCallSettings {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else {
                ringTimeoutSection
                maxDurationSection
                parallelRingSection
                saveSection

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
        .navigationTitle(NSLocalizedString("admin_call_settings", comment: "Call Settings"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadCallSettings()
        }
        .accessibilityIdentifier("call-settings-view")
    }

    // MARK: - Ring Timeout

    private var ringTimeoutSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(NSLocalizedString("admin_call_ring_timeout", comment: "Ring Timeout"))
                        .font(.brand(.body))
                    Spacer()
                    Text(L10n.format(
                        "admin_call_seconds_format",
                        comment: "%d seconds",
                        viewModel.callSettings.ringTimeout
                    ))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandPrimary)
                    .fontWeight(.medium)
                }

                Slider(
                    value: Binding(
                        get: { Double(viewModel.callSettings.ringTimeout) },
                        set: { viewModel.callSettings.ringTimeout = Int($0) }
                    ),
                    in: 15...60,
                    step: 5
                )
                .tint(Color.brandPrimary)
                .accessibilityIdentifier("ring-timeout-slider")
            }
        } footer: {
            Text(NSLocalizedString(
                "admin_call_ring_timeout_footer",
                comment: "How long each volunteer's phone rings before moving on (15-60 seconds)."
            ))
            .font(.brand(.caption))
        }
    }

    // MARK: - Max Duration

    private var maxDurationSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(NSLocalizedString("admin_call_max_duration", comment: "Max Call Duration"))
                        .font(.brand(.body))
                    Spacer()
                    Text(L10n.format(
                        "admin_call_minutes_format",
                        comment: "%d minutes",
                        viewModel.callSettings.maxDuration
                    ))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandPrimary)
                    .fontWeight(.medium)
                }

                Slider(
                    value: Binding(
                        get: { Double(viewModel.callSettings.maxDuration) },
                        set: { viewModel.callSettings.maxDuration = Int($0) }
                    ),
                    in: 5...120,
                    step: 5
                )
                .tint(Color.brandPrimary)
                .accessibilityIdentifier("max-duration-slider")
            }
        } footer: {
            Text(NSLocalizedString(
                "admin_call_max_duration_footer",
                comment: "Maximum allowed call length before automatic disconnect (5-120 minutes)."
            ))
            .font(.brand(.caption))
        }
    }

    // MARK: - Parallel Ring Count

    private var parallelRingSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(NSLocalizedString("admin_call_parallel_ring", comment: "Parallel Ring Count"))
                        .font(.brand(.body))
                    Spacer()
                    Text(L10n.format(
                        "admin_call_volunteers_format",
                        comment: "%d volunteers",
                        viewModel.callSettings.parallelRingCount
                    ))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandPrimary)
                    .fontWeight(.medium)
                }

                Slider(
                    value: Binding(
                        get: { Double(viewModel.callSettings.parallelRingCount) },
                        set: { viewModel.callSettings.parallelRingCount = Int($0) }
                    ),
                    in: 1...10,
                    step: 1
                )
                .tint(Color.brandPrimary)
                .accessibilityIdentifier("parallel-ring-slider")
            }
        } footer: {
            Text(NSLocalizedString(
                "admin_call_parallel_ring_footer",
                comment: "Number of on-shift volunteers to ring simultaneously (1-10)."
            ))
            .font(.brand(.caption))
        }
    }

    // MARK: - Save Section

    private var saveSection: some View {
        Section {
            Button {
                Task { await viewModel.saveCallSettings() }
            } label: {
                HStack {
                    Spacer()
                    if viewModel.isSavingCallSettings {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Text(NSLocalizedString("admin_save", comment: "Save"))
                            .fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(viewModel.isSavingCallSettings)
            .accessibilityIdentifier("call-settings-save-button")
        }
    }
}
