import SwiftUI

// MARK: - TranscriptionSettingsView

/// Settings view for on-device call transcription.
/// Allows enabling/disabling transcription, selecting the recognition language,
/// and shows the privacy notice that audio never leaves the device.
struct TranscriptionSettingsView: View {
    let transcriptionService: TranscriptionService

    @State private var showUnavailableAlert: Bool = false

    /// Filtered subset of supported locales showing human-readable language names.
    private var languageOptions: [(id: String, name: String)] {
        let locales = transcriptionService.supportedLocales
        var options: [(id: String, name: String)] = [
            (id: "", name: NSLocalizedString("transcription_language_auto", comment: "Auto-detect")),
        ]
        for locale in locales {
            let name = locale.localizedString(forIdentifier: locale.identifier) ?? locale.identifier
            options.append((id: locale.identifier, name: name))
        }
        return options
    }

    var body: some View {
        List {
            // Enable/disable section
            enableSection

            // Language selection
            if transcriptionService.isEnabled {
                languageSection
            }

            // Privacy notice
            privacySection
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("transcription_title", comment: "Transcription"))
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            NSLocalizedString("transcription_on_device_unavailable", comment: ""),
            isPresented: $showUnavailableAlert
        ) {
            Button(NSLocalizedString("action_done", comment: "OK")) {}
        }
    }

    // MARK: - Enable Section

    private var enableSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { transcriptionService.isEnabled },
                set: { newValue in
                    if newValue && !transcriptionService.isAvailable {
                        showUnavailableAlert = true
                        return
                    }
                    transcriptionService.isEnabled = newValue
                }
            )) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(NSLocalizedString("transcription_enable_on_device", comment: "Enable on-device transcription"))
                            .foregroundStyle(Color.brandForeground)
                        Text(NSLocalizedString("transcription_on_device_description", comment: ""))
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                } icon: {
                    Image(systemName: "waveform")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("transcription-enable-toggle")
        } header: {
            Text(NSLocalizedString("transcription_on_device", comment: "On-Device Transcription"))
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)
        }
    }

    // MARK: - Language Section

    private var languageSection: some View {
        Section {
            Picker(selection: Binding(
                get: { transcriptionService.selectedLanguage },
                set: { transcriptionService.selectedLanguage = $0 }
            )) {
                ForEach(languageOptions, id: \.id) { option in
                    Text(option.name).tag(option.id)
                }
            } label: {
                Label {
                    Text(NSLocalizedString("transcription_language_selection", comment: "Transcription Language"))
                } icon: {
                    Image(systemName: "globe")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("transcription-language-picker")
        } header: {
            Text(NSLocalizedString("transcription_language_selection", comment: "Language"))
        }
    }

    // MARK: - Privacy Section

    private var privacySection: some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "lock.shield.fill")
                    .font(.title2)
                    .foregroundStyle(Color.brandPrimary)

                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString("transcription_local_mic_only", comment: "Transcribes your speech only"))
                        .font(.brand(.subheadline))
                        .fontWeight(.medium)
                        .foregroundStyle(Color.brandForeground)

                    Text(NSLocalizedString("transcription_local_mic_only_description", comment: ""))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
            }
            .padding(.vertical, 4)
        } header: {
            Text(NSLocalizedString("help_security_title", comment: "Privacy"))
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Transcription Settings") {
    NavigationStack {
        TranscriptionSettingsView(
            transcriptionService: TranscriptionService()
        )
    }
}
#endif
