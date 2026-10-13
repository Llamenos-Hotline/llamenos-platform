import SwiftUI

// MARK: - SpamSettingsView

/// Admin view for the hub's spam mitigation: the per-number rate limit, how
/// long an offending number stays blocked, and the voice CAPTCHA.
///
/// Those four are the whole of `spamSettingsSchema`, surfaced to Swift as the
/// generated `SpamSettings`. The screen used to offer a "max calls per hour"
/// stepper and a "known number bypass" switch over a hand-written
/// `{ maxCallsPerHour, voiceCaptchaEnabled, knownNumberBypass }`: the rate
/// limit is per *minute*, the block duration was not offered at all, and the
/// server has no known-number bypass — so that switch promised to exempt
/// repeat callers from the CAPTCHA and controlled nothing. The load could not
/// decode and the Save button sent `PUT /api/settings/spam`, which answers 404
/// (#1724).
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
                saveSection

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                            .accessibilityIdentifier("spam-settings-error")
                    }
                }

                if let success = viewModel.successMessage {
                    Section {
                        Text(success)
                            .font(.brand(.footnote))
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("spam-settings-success")
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
            Toggle(isOn: $viewModel.spamRateLimitEnabled) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString("spam_rate_limiting", comment: "Rate Limiting"))
                        .font(.brand(.body))

                    Text(NSLocalizedString(
                        "spam_rate_limiting_description",
                        comment: "Limit repeated calls from the same number"
                    ))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                }
            }
            .tint(Color.brandPrimary)
            .accessibilityIdentifier("spam-rate-limit-toggle")

            countSlider(
                title: NSLocalizedString(
                    "spam_max_calls_per_minute",
                    comment: "Max calls per minute per number"
                ),
                identifier: "spam-max-calls",
                range: AdminViewModel.maxCallsPerMinuteRange,
                step: 1,
                value: $viewModel.spamMaxCallsPerMinute
            )

            countSlider(
                title: NSLocalizedString(
                    "spam_block_duration",
                    comment: "Block duration (minutes)"
                ),
                identifier: "spam-block-duration",
                range: AdminViewModel.blockDurationMinutesRange,
                step: 15,
                value: $viewModel.spamBlockDurationMinutes
            )
        } header: {
            Text(NSLocalizedString("admin_spam_rate_limit_header", comment: "Rate Limiting"))
        }
    }

    // MARK: - CAPTCHA Section

    private var captchaSection: some View {
        Section {
            Toggle(isOn: $viewModel.spamVoiceCaptchaEnabled) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString("spam_voice_captcha", comment: "Voice CAPTCHA"))
                        .font(.brand(.body))

                    Text(NSLocalizedString(
                        "spam_voice_captcha_description",
                        comment: "Require callers to enter a random number before connecting"
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

    /// One labelled slider over a whole-number setting, matching the shape the
    /// call settings screen uses.
    ///
    /// The current value carries its own identifier (`<identifier>-value`), and
    /// sits outside the slider, so a test can read what the screen is about to
    /// save and compare it with what the server stored. The number itself is
    /// formatted by Foundation rather than through a localized format string:
    /// it is a bare count, and the unit is already in the label.
    ///
    /// A slider rather than a `Stepper` on purpose. Putting the value label
    /// inside a `Stepper`'s own label displaces the stepper's accessibility
    /// element, so neither the value nor its Increment button is reliably
    /// addressable — and a control a test cannot drive is how the four
    /// `…HasSaveButton` assertions this screen used to carry became the only
    /// thing anyone checked.
    private func countSlider(
        title: String,
        identifier: String,
        range: ClosedRange<Int>,
        step: Int,
        value: Binding<Int>
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.brand(.body))
                Spacer()
                Text(value.wrappedValue.formatted())
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
                in: Double(range.lowerBound)...Double(range.upperBound),
                step: Double(step)
            )
            .tint(Color.brandPrimary)
            .accessibilityIdentifier("\(identifier)-slider")
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
