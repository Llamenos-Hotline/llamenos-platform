import SwiftUI

// MARK: - SignalRegistrationView

/// Full Signal registration state machine UI.
/// States: idle → registering (request in flight) → pending / verifying (code entry) → complete / failed
struct SignalRegistrationView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel: SignalRegistrationViewModel

    init(appState: AppState) {
        let service = ProviderSetupService(api: appState.apiService)
        _viewModel = State(initialValue: SignalRegistrationViewModel(
            service: service,
            hubContext: appState.hubContext
        ))
    }

    var body: some View {
        Form {
            Group {
                switch currentPhase {
                case .idle:
                    registrationFormSection
                    methodSection
                    startSection
                case .registering:
                    pendingSection(message: NSLocalizedString("signal_registering", comment: "Registering..."), showCode: false)
                case .pendingVerification:
                    pendingSection(message: NSLocalizedString("signal_pending_verification", comment: "Waiting for verification code..."), showCode: true)
                case .verified:
                    successSection
                case .failed:
                    failedSection
                }
            }

            if let error = viewModel.error {
                Section {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                }
            }
        }
        .navigationTitle(NSLocalizedString("signal_registration_title", comment: "Signal Registration"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadExistingState()
        }
        .accessibilityIdentifier("signal-registration-view")
    }

    // MARK: - Phase

    private enum Phase {
        case idle
        case registering
        case pendingVerification
        case verified
        case failed
    }

    private var currentPhase: Phase {
        if viewModel.isRegistering { return .registering }
        guard let state = viewModel.state else { return .idle }
        switch state.status {
        case .idle: return .idle
        case .pending, .verifying: return .pendingVerification
        case .complete: return .verified
        case .failed: return .failed
        }
    }

    // MARK: - Form Sections

    private var registrationFormSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("signal_bridge_url_label", comment: "Bridge URL"))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                TextField(
                    NSLocalizedString("signal_bridge_url_placeholder", comment: "https://signal-bridge.example.com"),
                    text: $viewModel.bridgeURL
                )
                .font(.brandMono(.body))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .accessibilityIdentifier("signal-bridge-url")
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("signal_bridge_api_key_label", comment: "Bridge API Key"))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                SecureField(
                    NSLocalizedString("signal_bridge_api_key_placeholder", comment: "Enter API key"),
                    text: $viewModel.bridgeAPIKey
                )
                .font(.brandMono(.body))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("signal-bridge-api-key")
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("signal_phone_number_label", comment: "Phone Number"))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                TextField(
                    NSLocalizedString("signal_phone_number_placeholder", comment: "+1234567890"),
                    text: $viewModel.phoneNumber
                )
                .font(.brandMono(.body))
                .keyboardType(.phonePad)
                .accessibilityIdentifier("signal-phone-number")
            }
        } header: {
            Text(NSLocalizedString("signal_bridge_config_header", comment: "Bridge Configuration"))
        } footer: {
            Text(NSLocalizedString("signal_bridge_footer", comment: "The Signal bridge connects your Llamenos hub to the Signal messaging network."))
                .font(.brand(.caption))
        }
    }

    private var methodSection: some View {
        Section {
            Toggle(
                NSLocalizedString("signal_use_voice", comment: "Use Voice Verification"),
                isOn: $viewModel.useVoice
            )
            .accessibilityIdentifier("signal-use-voice-toggle")
        } header: {
            Text(NSLocalizedString("signal_verification_method_header", comment: "Verification Method"))
        } footer: {
            Text(
                viewModel.useVoice
                    ? NSLocalizedString("signal_voice_method_footer", comment: "You will receive a phone call with a verification code.")
                    : NSLocalizedString("signal_sms_method_footer", comment: "You will receive an SMS with a verification code.")
            )
            .font(.brand(.caption))
        }
    }

    private var startSection: some View {
        Section {
            Button {
                Task { await viewModel.startRegistration() }
            } label: {
                Text(NSLocalizedString("signal_start_registration_button", comment: "Start Registration"))
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!viewModel.formValid || viewModel.isRegistering)
            .accessibilityIdentifier("signal-start-button")
        }
    }

    private func pendingSection(message: String, showCode: Bool) -> some View {
        Group {
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text(message)
                        .font(.brand(.body))
                        .foregroundStyle(.secondary)
                }

                if let state = viewModel.state {
                    LabeledContent(NSLocalizedString("signal_registered_number", comment: "Registered Number")) {
                        Text(state.phoneNumberMasked)
                            .font(.brandMono(.body))
                    }
                }
            } header: {
                Text(NSLocalizedString("signal_status_header", comment: "Registration Status"))
            }

            if showCode {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(NSLocalizedString("signal_code_label", comment: "Verification Code"))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        TextField(
                            NSLocalizedString("signal_code_placeholder", comment: "Enter code"),
                            text: $viewModel.verificationCode
                        )
                        .font(.brandMono(.title3))
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier("signal-verification-code")
                    }

                    Button {
                        Task { await viewModel.verifyCode() }
                    } label: {
                        HStack {
                            if viewModel.isVerifying {
                                ProgressView().scaleEffect(0.8).padding(.trailing, 4)
                            }
                            Text(NSLocalizedString("signal_verify_button", comment: "Verify Code"))
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.verificationCode.isEmpty || viewModel.isVerifying)
                    .accessibilityIdentifier("signal-verify-button")
                } header: {
                    Text(NSLocalizedString("signal_code_entry_header", comment: "Enter Code"))
                } footer: {
                    Text(NSLocalizedString("signal_code_footer", comment: "Enter the code from the verification message."))
                        .font(.brand(.caption))
                }

                Section {
                    Button(role: .destructive) {
                        Task { await viewModel.unregister() }
                    } label: {
                        HStack {
                            if viewModel.isUnregistering {
                                ProgressView().scaleEffect(0.8).padding(.trailing, 4)
                            }
                            Text(NSLocalizedString("signal_cancel_registration", comment: "Cancel Registration"))
                        }
                    }
                    .disabled(viewModel.isUnregistering)
                    .accessibilityIdentifier("signal-cancel-button")
                }
            }
        }
    }

    private var successSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.green)

                VStack(alignment: .leading, spacing: 2) {
                    Text(NSLocalizedString("signal_registered_success", comment: "Signal registered successfully"))
                        .font(.brand(.headline))

                    if let number = viewModel.state?.phoneNumberMasked {
                        Text(number)
                            .font(.brandMono(.caption))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 4)

            Button(role: .destructive) {
                Task { await viewModel.unregister() }
            } label: {
                HStack {
                    if viewModel.isUnregistering {
                        ProgressView().scaleEffect(0.8).padding(.trailing, 4)
                    }
                    Text(NSLocalizedString("signal_unregister_button", comment: "Unregister Signal"))
                }
            }
            .disabled(viewModel.isUnregistering)
            .accessibilityIdentifier("signal-unregister-button")
        } header: {
            Text(NSLocalizedString("signal_status_header", comment: "Registration Status"))
        }
    }

    private var failedSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(Color.brandDestructive)

                VStack(alignment: .leading, spacing: 2) {
                    Text(NSLocalizedString("signal_registration_failed", comment: "Registration failed"))
                    .font(.brand(.headline))
                    .foregroundStyle(Color.brandDestructive)

                    if let error = viewModel.state?.error {
                        Text(error)
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 4)

            Button {
                viewModel.state = nil
                viewModel.error = nil
                viewModel.verificationCode = ""
            } label: {
                Text(NSLocalizedString("signal_retry_button", comment: "Try Again"))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("signal-retry-button")
        } header: {
            Text(NSLocalizedString("signal_status_header", comment: "Registration Status"))
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Signal Registration") {
    NavigationStack {
        SignalRegistrationView(appState: AppState(hubContext: HubContext()))
    }
}
#endif
