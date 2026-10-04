import SwiftUI

// MARK: - AccountRecoveryView

/// Unauthenticated user flow for recovering an account after device loss.
/// Presented from the login screen via "I lost my device" link.
struct AccountRecoveryView: View {
    @State private var step: RecoveryStep = .identifier
    @State private var userIdentifier: String = ""
    @State private var selectedHubId: String = ""
    @State private var sessionId: String = ""
    @State private var verificationCode: String = ""
    @State private var newPin: String = ""
    @State private var confirmPin: String = ""
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?
    @State private var contributionCount: Int = 0
    @State private var requiredApprovals: Int = 0
    @State private var delayRemainingMs: Int = 0
    @State private var pollTimer: Timer?
    @State private var sessionStatus: String = ""

    @Environment(\.dismiss) private var dismiss

    private let cryptoService: CryptoService
    private let apiService: APIService

    init(cryptoService: CryptoService, apiService: APIService) {
        self.cryptoService = cryptoService
        self.apiService = apiService
    }

    enum RecoveryStep {
        case identifier
        case signalVerification
        case waiting
        case complete
        case setPin
    }

    var body: some View {
        NavigationStack {
            VStack {
                switch step {
                case .identifier:
                    identifierStep
                case .signalVerification:
                    signalVerificationStep
                case .waiting:
                    waitingStep
                case .complete:
                    completeStep
                case .setPin:
                    setPinStep
                }
            }
            .padding()
            .navigationTitle(NSLocalizedString("recovery_group_initiate_title", comment: "Account recovery"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        pollTimer?.invalidate()
                        dismiss()
                    }
                }
            }
        }
    }

    // MARK: - Step 1: Identifier

    private var identifierStep: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image(systemName: "person.badge.key.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.brandPrimary)

                Text(NSLocalizedString("recovery_group_initiate_description", comment: ""))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandMutedForeground)
                    .multilineTextAlignment(.center)

                VStack(alignment: .leading, spacing: 8) {
                    Text(NSLocalizedString("recovery_group_initiate_identifier", comment: "Your email or phone number"))
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    TextField(
                        NSLocalizedString("recovery_group_initiate_identifier", comment: ""),
                        text: $userIdentifier
                    )
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .accessibilityIdentifier("recovery-identifier-input")
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(NSLocalizedString("recovery_group_initiate_select_hub", comment: "Select your organization"))
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    TextField(
                        NSLocalizedString("recovery_group_initiate_select_hub", comment: ""),
                        text: $selectedHubId
                    )
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("recovery-hub-input")
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                        .accessibilityIdentifier("recovery-error")
                }

                Button {
                    Task { await submitRecoveryRequest() }
                } label: {
                    if isSubmitting {
                        HStack(spacing: 8) {
                            ProgressView().tint(.white)
                            Text(NSLocalizedString("recovery_group_initiate_submitting", comment: "Starting..."))
                        }
                    } else {
                        Text(NSLocalizedString("recovery_group_initiate_submit", comment: "Start recovery"))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(userIdentifier.isEmpty || selectedHubId.isEmpty || isSubmitting)
                .accessibilityIdentifier("start-recovery-button")
            }
        }
    }

    // MARK: - Step 2: Signal Verification

    private var signalVerificationStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.brandPrimary)

            Text(NSLocalizedString("recovery_group_initiate_signal_verification", comment: ""))
                .font(.brand(.body))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: 8) {
                Text(NSLocalizedString("recovery_group_initiate_verification_code", comment: "Verification code"))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                TextField("000000", text: $verificationCode)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)
                    .font(.brandMono(.title2))
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("recovery-verification-code-input")
            }

            if let error = errorMessage {
                Text(error)
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandDestructive)
            }

            Button {
                Task { await verifyCode() }
            } label: {
                if isSubmitting {
                    ProgressView().tint(.white)
                } else {
                    Text(NSLocalizedString("recovery_group_initiate_verify", comment: "Verify"))
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(verificationCode.count < 4 || isSubmitting)
            .accessibilityIdentifier("verify-recovery-code-button")
        }
    }

    // MARK: - Step 3: Waiting for Approvals

    private var waitingStep: some View {
        VStack(spacing: 24) {
            ProgressView()
                .scaleEffect(1.5)
                .padding()

            Text(NSLocalizedString("recovery_group_initiate_waiting", comment: "Waiting for your recovery contacts to approve"))
                .font(.brand(.headline))
                .multilineTextAlignment(.center)

            VStack(spacing: 8) {
                Text("\(contributionCount) / \(requiredApprovals)")
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandMutedForeground)

                ProgressView(value: Double(contributionCount), total: Double(max(requiredApprovals, 1)))
                    .tint(Color.brandPrimary)
                    .accessibilityIdentifier("recovery-approval-progress")
            }

            if delayRemainingMs > 0 {
                let hours = delayRemainingMs / 3_600_000
                let minutes = (delayRemainingMs % 3_600_000) / 60_000
                Text("\(hours)h \(minutes)m")
                    .font(.brand(.body))
                    .foregroundStyle(.orange)
            }

            RecoveryStatusBadge(status: sessionStatus)
                .accessibilityIdentifier("recovery-session-status")
        }
        .onAppear { startPolling() }
        .onDisappear { pollTimer?.invalidate() }
    }

    // MARK: - Step 4: Complete

    private var completeStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)

            Text(NSLocalizedString("recovery_group_initiate_complete", comment: "Account recovered"))
                .font(.brand(.title2))
                .fontWeight(.bold)

            Text(NSLocalizedString("recovery_group_initiate_success", comment: "You're all set."))
                .font(.brand(.body))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)

            Button {
                step = .setPin
            } label: {
                Text(NSLocalizedString("recovery_group_initiate_set_pin", comment: "Set a PIN"))
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("recovery-set-pin-button")
        }
    }

    // MARK: - Step 5: Set PIN

    private var setPinStep: some View {
        VStack(spacing: 24) {
            Image(systemName: "lock.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.brandPrimary)

            Text(NSLocalizedString("recovery_group_initiate_set_pin", comment: "Set a PIN to protect your new device"))
                .font(.brand(.headline))
                .multilineTextAlignment(.center)

            SecureField(NSLocalizedString("pin_enter_pin", comment: "Enter PIN"), text: $newPin)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.numberPad)
                .accessibilityIdentifier("recovery-new-pin-input")

            SecureField(NSLocalizedString("pin_confirm_title", comment: "Confirm PIN"), text: $confirmPin)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.numberPad)
                .accessibilityIdentifier("recovery-confirm-pin-input")

            if let error = errorMessage {
                Text(error)
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandDestructive)
            }

            Button {
                Task { await completeRecoveryWithPin() }
            } label: {
                if isSubmitting {
                    ProgressView().tint(.white)
                } else {
                    Text(NSLocalizedString("action_save", comment: "Save"))
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(newPin.count < 6 || newPin != confirmPin || isSubmitting)
            .accessibilityIdentifier("recovery-save-pin-button")
        }
    }

    // MARK: - Actions

    private func submitRecoveryRequest() async {
        isSubmitting = true
        errorMessage = nil
        do {
            let deviceId = UUID().uuidString
            let tempPin = "000000"
            let encrypted = try cryptoService.generateDeviceKeys(deviceId: deviceId, pin: tempPin)
            let pubkey = encrypted.state.encryptionPubkeyHex

            let response = try await apiService.initiateRecovery(
                hubId: selectedHubId,
                userIdentifier: userIdentifier,
                newDevicePubkey: pubkey
            )
            sessionId = response.sessionId
            step = .signalVerification
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }

    private func verifyCode() async {
        isSubmitting = true
        errorMessage = nil
        do {
            _ = try await apiService.verifyRecoveryCode(
                sessionId: sessionId,
                verificationCode: verificationCode
            )
            step = .waiting
        } catch {
            errorMessage = NSLocalizedString("recovery_group_error_signal_verification_failed", comment: "")
        }
        isSubmitting = false
    }

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
            Task { await pollSessionStatus() }
        }
    }

    private func pollSessionStatus() async {
        do {
            let status = try await apiService.getRecoverySession(sessionId: sessionId)
            await MainActor.run {
                contributionCount = Int(status.contributionCount)
                requiredApprovals = Int(status.threshold)
                delayRemainingMs = Int(status.delayRemainingMS)
                sessionStatus = status.status.rawValue
                if status.status == .completed {
                    pollTimer?.invalidate()
                    step = .complete
                } else if status.status == .expired || status.status == .cancelled {
                    pollTimer?.invalidate()
                    errorMessage = NSLocalizedString("recovery_group_error_session_expired", comment: "")
                }
            }
        } catch {
            // Silently retry on network errors during polling
        }
    }

    private func completeRecoveryWithPin() async {
        guard newPin == confirmPin, newPin.count >= 6 else {
            errorMessage = NSLocalizedString("error_invalid_pin", comment: "")
            return
        }
        isSubmitting = true
        // In practice: re-encrypt device keys with new PIN, store, dismiss
        isSubmitting = false
        dismiss()
    }
}
