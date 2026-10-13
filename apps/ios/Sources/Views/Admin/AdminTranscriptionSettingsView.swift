import SwiftUI

// MARK: - AdminTranscriptionSettingsView

/// Admin view for the hub's two transcription settings: whether call
/// transcription is on at all, and whether a user may turn it off for their
/// own calls.
///
/// Those are the whole of `transcriptionSettingsSchema` — `globalEnabled` and
/// `allowUserOptOut`, surfaced to Swift as the generated
/// `TranscriptionSettings`. The screen used to decode the route's answer into a
/// hand-written `{ enabled, allowVolunteerOptOut }`, so the load failed and the
/// toggles showed hardcoded `false`s, and its Save button sent
/// `PUT /api/settings/transcription` — a verb the server does not mount,
/// answering 404 every time (#1724).
struct AdminTranscriptionSettingsView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        Form {
            if viewModel.isLoadingTranscription {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else {
                transcriptionSection
                optOutSection
                saveSection

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                            .accessibilityIdentifier("transcription-settings-error")
                    }
                }

                if let success = viewModel.successMessage {
                    Section {
                        Text(success)
                            .font(.brand(.footnote))
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("transcription-settings-success")
                    }
                }
            }
        }
        .navigationTitle(NSLocalizedString("admin_transcription_settings", comment: "Transcription"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadTranscriptionSettings()
        }
        .accessibilityIdentifier("transcription-settings-view")
    }

    // MARK: - Transcription Toggle

    private var transcriptionSection: some View {
        Section {
            settingToggle(
                title: NSLocalizedString(
                    "admin_transcription_enabled",
                    comment: "Enable Transcription"
                ),
                description: NSLocalizedString(
                    "admin_transcription_enabled_desc",
                    comment: "Automatically transcribe calls using on-device Whisper"
                ),
                identifier: "transcription-enabled-toggle",
                isOn: $viewModel.transcriptionGlobalEnabled
            )
        } header: {
            Text(NSLocalizedString("admin_transcription_header", comment: "Transcription"))
        }
    }

    // MARK: - Opt-Out Section

    private var optOutSection: some View {
        Section {
            settingToggle(
                title: NSLocalizedString(
                    "admin_transcription_optout",
                    comment: "Allow Volunteer Opt-Out"
                ),
                description: NSLocalizedString(
                    "admin_transcription_optout_desc",
                    comment: "Let volunteers disable transcription for their calls"
                ),
                identifier: "transcription-opt-out-toggle",
                isOn: $viewModel.transcriptionAllowUserOptOut
            )
            .disabled(!viewModel.transcriptionGlobalEnabled)
        } header: {
            Text(NSLocalizedString(
                "admin_transcription_volunteer_header",
                comment: "Volunteer Opt-Out"
            ))
        } footer: {
            Text(NSLocalizedString(
                "transcription_allow_opt_out_description",
                comment: "When disabled, volunteers cannot opt out of call transcription"
            ))
            .font(.brand(.caption))
        }
    }

    /// One labelled switch. The identifier is on the `Toggle` itself, so a test
    /// reads its `value` ("0"/"1") and can compare what the screen shows against
    /// what the server stored — an assertion that the switch merely *exists*
    /// stayed green throughout the period in which saving was impossible.
    private func settingToggle(
        title: String,
        description: String,
        identifier: String,
        isOn: Binding<Bool>
    ) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.brand(.body))

                Text(description)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
        .tint(Color.brandPrimary)
        .accessibilityIdentifier(identifier)
    }

    // MARK: - Save Section

    private var saveSection: some View {
        Section {
            Button {
                Task { await viewModel.saveTranscriptionSettings() }
            } label: {
                HStack {
                    Spacer()
                    if viewModel.isSavingTranscription {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Text(NSLocalizedString("admin_save", comment: "Save"))
                            .fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(viewModel.isSavingTranscription)
            .accessibilityIdentifier("transcription-save-button")
        }
    }
}
