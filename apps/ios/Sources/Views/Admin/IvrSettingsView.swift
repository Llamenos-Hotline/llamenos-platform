import SwiftUI

// MARK: - IvrSettingsView

/// Admin view for the IVR language menu: which languages a caller can choose
/// from the keypad, and in what order.
///
/// The server's shape is `ivrLanguagesSchema` — an ordered
/// `enabledLanguages: [String]`, generated as `IvrLanguages`. Order is the
/// point: position decides which digit selects the language, and anything past
/// position 8 moves into a sub-menu. This screen used to hold a
/// `[String: Bool]` map, which has no order at all, and send it to
/// `PUT /api/settings/ivr-languages` — a verb the server does not mount (404);
/// on the verb it does mount, that body answers 400, `expected array, received
/// undefined`. See #1724.
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
                enabledSection
                languagesSection
                saveSection

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                            .accessibilityIdentifier("ivr-settings-error")
                    }
                }

                if let success = viewModel.successMessage {
                    Section {
                        Text(success)
                            .font(.brand(.footnote))
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("ivr-settings-success")
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

    // MARK: - Enabled Languages (ordered)

    /// The enabled languages in the order the caller hears them, each with the
    /// digit that selects it. The whole list is also exposed as one string on
    /// `ivr-enabled-order`, which is what a test compares against
    /// `GET /api/settings/ivr-languages`: the order is a setting in its own
    /// right, and a per-row assertion would not see it move.
    private var enabledSection: some View {
        Section {
            if viewModel.ivrEnabledLanguages.isEmpty {
                Text(NSLocalizedString(
                    "ivr_at_least_one",
                    comment: "At least one language must be enabled."
                ))
                .font(.brand(.footnote))
                .foregroundStyle(Color.brandDestructive)
            } else {
                ForEach(Array(viewModel.ivrEnabledLanguages.enumerated()), id: \.element) { index, code in
                    HStack(spacing: 12) {
                        Text(Self.digitLabel(index))
                            .font(.brandMono(.footnote))
                            .foregroundStyle(Color.brandPrimary)
                            .frame(minWidth: 28, alignment: .leading)

                        Text(Self.languageName(code))
                            .font(.brand(.body))

                        Spacer()

                        if index >= Self.subMenuThreshold {
                            Text(NSLocalizedString("ivr_sub_menu", comment: "sub-menu"))
                                .font(.brand(.caption))
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                    }
                }
            }

            Text(viewModel.ivrEnabledLanguages.joined(separator: ","))
                .font(.brand(.caption))
                .foregroundStyle(Color.brandMutedForeground)
                .accessibilityIdentifier("ivr-enabled-order")
        } header: {
            Text(NSLocalizedString("ivr_enabled_languages", comment: "Enabled languages (ordered)"))
        } footer: {
            Text(NSLocalizedString(
                "ivr_sub_menu_note",
                comment: "Languages after position 8 are in a sub-menu."
            ))
            .font(.brand(.caption))
        }
    }

    // MARK: - Available Languages

    private var languagesSection: some View {
        Section {
            ForEach(AdminViewModel.supportedLanguages, id: \.code) { language in
                Toggle(isOn: Binding(
                    get: { viewModel.ivrEnabledLanguages.contains(language.code) },
                    set: { viewModel.setIvrLanguage(language.code, enabled: $0) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(language.name)
                            .font(.brand(.body))
                        Text(language.code.uppercased())
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                }
                .tint(Color.brandPrimary)
                .accessibilityIdentifier("ivr-language-\(language.code)")
            }
        } header: {
            Text(NSLocalizedString("ivr_available_languages", comment: "Available languages"))
        } footer: {
            Text(NSLocalizedString(
                "ivr_description",
                comment: "Configure which languages callers can select from via keypad."
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
            .disabled(viewModel.isSavingIvrLanguages || viewModel.ivrEnabledLanguages.isEmpty)
            .accessibilityIdentifier("ivr-save-button")
        }
    }

    // MARK: - Helpers

    /// Positions from this index on are reached through the "more languages"
    /// digit — `ivrIndexToDigit` in `packages/i18n/languages.ts`, which the
    /// server's IVR menu builder uses.
    private static let subMenuThreshold = 8

    /// The keypad digit that selects the language at `index`.
    private static func digitLabel(_ index: Int) -> String {
        index < subMenuThreshold ? String(index + 1) : "9·\(index - subMenuThreshold + 1)"
    }

    /// The language's own name, or the bare code if the server has a language
    /// this build does not list — shown rather than hidden, because a code the
    /// screen cannot name is still enabled for callers.
    private static func languageName(_ code: String) -> String {
        AdminViewModel.supportedLanguages.first { $0.code == code }?.name ?? code.uppercased()
    }
}
