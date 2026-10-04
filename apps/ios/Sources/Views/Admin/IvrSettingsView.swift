import SwiftUI

// MARK: - IvrSettingsView

/// Admin view for configuring IVR language support. Toggles each of the 13
/// supported languages on or off for the voice menu system.
struct IvrSettingsView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        Form {
            if viewModel.isLoadingIvrLanguages {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else {
                languagesSection
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
        .navigationTitle(NSLocalizedString("admin_ivr_settings", comment: "IVR Languages"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadIvrLanguages()
        }
        .accessibilityIdentifier("ivr-settings-view")
    }

    // MARK: - Languages Section

    private var languagesSection: some View {
        Section {
            ForEach(AdminViewModel.supportedLanguages, id: \.code) { language in
                Toggle(isOn: Binding(
                    get: { viewModel.ivrLanguages[language.code] ?? false },
                    set: { viewModel.ivrLanguages[language.code] = $0 }
                )) {
                    HStack(spacing: 8) {
                        Text(flagEmoji(for: language.code))
                            .font(.title3)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(language.name)
                                .font(.brand(.body))
                            Text(language.code.uppercased())
                                .font(.brand(.caption))
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                    }
                }
                .tint(Color.brandPrimary)
                .accessibilityIdentifier("ivr-language-\(language.code)")
            }
        } header: {
            Text(NSLocalizedString("admin_ivr_languages_header", comment: "Supported Languages"))
        } footer: {
            let enabledCount = viewModel.ivrLanguages.values.filter { $0 }.count
            Text(L10n.format(
                "admin_ivr_languages_footer",
                comment: "%d of %d languages enabled for the IVR voice menu.",
                enabledCount, AdminViewModel.supportedLanguages.count
            ))
            .font(.brand(.caption))
        }
    }

    // MARK: - Save Section

    private var saveSection: some View {
        Section {
            Button {
                Task { await viewModel.saveIvrLanguages() }
            } label: {
                HStack {
                    Spacer()
                    if viewModel.isSavingIvrLanguages {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Text(NSLocalizedString("admin_save", comment: "Save"))
                            .fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(viewModel.isSavingIvrLanguages)
            .accessibilityIdentifier("ivr-save-button")
        }
    }

    // MARK: - Helpers

    /// Map language codes to flag emoji for visual differentiation.
    private func flagEmoji(for code: String) -> String {
        switch code {
        case "en": return "\u{1F1FA}\u{1F1F8}"
        case "es": return "\u{1F1EA}\u{1F1F8}"
        case "zh": return "\u{1F1E8}\u{1F1F3}"
        case "tl": return "\u{1F1F5}\u{1F1ED}"
        case "vi": return "\u{1F1FB}\u{1F1F3}"
        case "ar": return "\u{1F1F8}\u{1F1E6}"
        case "fr": return "\u{1F1EB}\u{1F1F7}"
        case "ht": return "\u{1F1ED}\u{1F1F9}"
        case "ko": return "\u{1F1F0}\u{1F1F7}"
        case "ru": return "\u{1F1F7}\u{1F1FA}"
        case "hi": return "\u{1F1EE}\u{1F1F3}"
        case "pt": return "\u{1F1E7}\u{1F1F7}"
        case "de": return "\u{1F1E9}\u{1F1EA}"
        default: return "\u{1F310}"
        }
    }
}
