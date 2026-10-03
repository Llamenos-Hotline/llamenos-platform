import SwiftUI

// MARK: - SpamSettingsView

/// Admin view for configuring spam mitigation: rate limiting, voice CAPTCHA,
/// and known-number bypass.
struct SpamSettingsView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        Form {
            if viewModel.isLoadingSpamSettings {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else {
                rateLimitSection
                captchaSection
                bypassSection
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
        .navigationTitle(NSLocalizedString("admin_spam_settings", comment: "Spam Settings"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadSpamSettings()
        }
        .accessibilityIdentifier("spam-settings-view")
    }

    // MARK: - Rate Limit Section

    private var rateLimitSection: some View {
        Section {
            Stepper(
                value: Binding(
                    get: { viewModel.spamSettings.maxCallsPerHour },
                    set: { viewModel.spamSettings.maxCallsPerHour = $0 }
                ),
                in: 1...100
            ) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString(
                        "admin_spam_max_calls",
                        comment: "Max Calls Per Hour"
                    ))
                    .font(.brand(.body))

                    Text(L10n.format(
                        "admin_spam_max_calls_value",
                        comment: "%d calls per number per hour",
                        viewModel.spamSettings.maxCallsPerHour
                    ))
                    .font(.brand(.subheadline))
                    .foregroundStyle(Color.brandPrimary)
                    .fontWeight(.medium)
                }
            }
            .accessibilityIdentifier("spam-max-calls-stepper")
        } header: {
            Text(NSLocalizedString("admin_spam_rate_limit_header", comment: "Rate Limiting"))
        } footer: {
            Text(NSLocalizedString(
                "admin_spam_rate_limit_footer",
                comment: "Limit how many times the same number can call within one hour. Excess calls are rejected."
            ))
            .font(.brand(.caption))
        }
    }

    // MARK: - CAPTCHA Section

    private var captchaSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { viewModel.spamSettings.voiceCaptchaEnabled },
                set: { viewModel.spamSettings.voiceCaptchaEnabled = $0 }
            )) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString(
                        "admin_spam_voice_captcha",
                        comment: "Voice CAPTCHA"
                    ))
                    .font(.brand(.body))

                    Text(NSLocalizedString(
                        "admin_spam_voice_captcha_description",
                        comment: "Require callers to press randomized digits before connecting to a volunteer."
                    ))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                }
            }
            .tint(Color.brandPrimary)
            .accessibilityIdentifier("spam-captcha-toggle")
        } header: {
            Text(NSLocalizedString("admin_spam_captcha_header", comment: "Bot Detection"))
        }
    }

    // MARK: - Bypass Section

    private var bypassSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { viewModel.spamSettings.knownNumberBypass },
                set: { viewModel.spamSettings.knownNumberBypass = $0 }
            )) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString(
                        "admin_spam_known_bypass",
                        comment: "Known Number Bypass"
                    ))
                    .font(.brand(.body))

                    Text(NSLocalizedString(
                        "admin_spam_known_bypass_description",
                        comment: "Skip CAPTCHA and rate limits for numbers that have called before without issues."
                    ))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                }
            }
            .tint(Color.brandPrimary)
            .accessibilityIdentifier("spam-bypass-toggle")
        } header: {
            Text(NSLocalizedString("admin_spam_bypass_header", comment: "Exemptions"))
        }
    }

    // MARK: - Save Section

    private var saveSection: some View {
        Section {
            Button {
                Task { await viewModel.saveSpamSettings() }
            } label: {
                HStack {
                    Spacer()
                    if viewModel.isSavingSpamSettings {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Text(NSLocalizedString("admin_save", comment: "Save"))
                            .fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(viewModel.isSavingSpamSettings)
            .accessibilityIdentifier("spam-save-button")
        }
    }
}
