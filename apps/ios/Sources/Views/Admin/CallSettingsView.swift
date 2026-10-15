import SwiftUI

// MARK: - CallSettingsView

/// Admin view for the hub's two call settings: how long a caller waits in the
/// queue before being sent to voicemail, and how long a voicemail recording may
/// run.
///
/// Those are the only call settings the server has — `callSettingsSchema` in
/// `packages/protocol/schemas/settings.ts`, which the desktop client edits as
/// `queueTimeoutSeconds` / `voicemailMaxSeconds`. This screen used to show
/// sliders for a ring timeout, a maximum call duration and a parallel ring
/// count: three settings with no server field, no storage and no effect, whose
/// Save button posted to a route that answered 404 (#1717).
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
                queueTimeoutSection
                voicemailMaxSection
                saveSection

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                            .accessibilityIdentifier("call-settings-error")
                    }
                }

                if let success = viewModel.successMessage {
                    Section {
                        Text(success)
                            .font(.brand(.footnote))
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("call-settings-success")
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

    // MARK: - Queue Timeout

    private var queueTimeoutSection: some View {
        secondsSection(
            title: NSLocalizedString("call_settings_queue_timeout", comment: "Queue Timeout"),
            footer: NSLocalizedString(
                "call_settings_queue_timeout_description",
                comment: "How long callers wait before being sent to voicemail (seconds)."
            ),
            identifier: "queue-timeout",
            value: $viewModel.queueTimeoutSeconds
        )
    }

    // MARK: - Voicemail Length

    private var voicemailMaxSection: some View {
        secondsSection(
            title: NSLocalizedString("call_settings_voicemail_max", comment: "Max Voicemail Length"),
            footer: NSLocalizedString(
                "call_settings_voicemail_max_description",
                comment: "Maximum recording length for voicemail messages (seconds)."
            ),
            identifier: "voicemail-max",
            value: $viewModel.voicemailMaxSeconds
        )
    }

    /// One labelled slider over the server's 30...300 second range.
    ///
    /// The current value carries its own identifier (`<identifier>-value`) so a
    /// test can read what the screen is about to save and compare it against
    /// what the server stored — an assertion that the button merely *exists*
    /// passed throughout the entire period in which saving was impossible.
    private func secondsSection(
        title: String,
        footer: String,
        identifier: String,
        value: Binding<Int>
    ) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title)
                        .font(.brand(.body))
                    Spacer()
                    Text(L10n.format("admin_seconds_unit", comment: "%ds", value.wrappedValue))
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandPrimary)
                        .fontWeight(.medium)
                        .accessibilityIdentifier("\(identifier)-value")
                }

                Slider(
                    value: Binding(
                        get: { Double(value.wrappedValue) },
                        set: { value.wrappedValue = Int($0) }
                    ),
                    in: AdminViewModel.callSecondsRange,
                    step: 15
                )
                .tint(Color.brandPrimary)
                .accessibilityIdentifier("\(identifier)-slider")
            }
        } footer: {
            Text(footer)
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
