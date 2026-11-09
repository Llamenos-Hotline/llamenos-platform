import SwiftUI

/// PIN unlock screen: user enters their PIN or passphrase (+ optional biometric)
/// to unlock a stored identity. Shown on app launch when encrypted keys exist, or
/// after background lock timeout.
///
/// Entry is a `SecureField`, not a digit pad: a credential may be any 8+
/// characters (letters included), which a 6/8-digit pad could never accept (#2303).
struct PINUnlockView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router
    @State private var pinViewModel: PINViewModel?
    @State private var hasAttemptedBiometric: Bool = false
    @State private var breatheScale: CGFloat = 1.0
    @State private var biometricPulse: CGFloat = 1.0

    var body: some View {
        let vm = resolvedPINViewModel

        VStack(spacing: 24) {
            Spacer()

            // Header
            VStack(spacing: 12) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Color.brandPrimary)
                    .scaleEffect(breatheScale)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
                            breatheScale = 1.03
                        }
                    }
                    .accessibilityHidden(true)

                Text(vm.titleText)
                    .font(.brand(.title2))
                    .fontWeight(.bold)

                // Show which identity is locked (truncated signing pubkey)
                if let signingPubkey = appState.cryptoService.signingPubkeyHex {
                    BrandCard {
                        CopyableField(
                            label: NSLocalizedString("identity_label", comment: "Identity"),
                            value: signingPubkey,
                            truncated: true
                        )
                    }
                    .accessibilityIdentifier("locked-identity")
                }

                Text(vm.subtitleText)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
            }

            // Error message
            if let error = vm.errorMessage {
                Text(error)
                    .font(.brand(.footnote))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
                    .accessibilityIdentifier("pin-error")
            }

            // Credential entry (secure text field — a credential may be any 8+
            // characters, so a digit-only pad cannot unlock it, #2303). Submit is
            // gated at 8 characters: every stored credential satisfies the
            // creation rule (`is_valid_credential`), so a shorter entry can only
            // be wrong — refusing it locally keeps a typo from burning one of the
            // ten lockout attempts.
            SecureField(
                NSLocalizedString("pin_enter_pin", comment: "Enter your PIN or passphrase"),
                text: Binding(
                    get: { vm.pin },
                    set: { vm.pin = $0 }
                )
            )
            .textFieldStyle(.roundedBorder)
            .font(.brand(.title3))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 40)
            .textContentType(.password)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .accessibilityIdentifier("pin-input")
            .onSubmit {
                if vm.pin.count >= 8 {
                    vm.onPINComplete(vm.pin)
                }
            }

            Button(NSLocalizedString("unlock_title", comment: "Unlock")) {
                vm.onPINComplete(vm.pin)
            }
            .buttonStyle(.borderedProminent)
            .disabled(vm.pin.count < 8)
            .accessibilityIdentifier("pin-submit")

            // Biometric button (if available and enabled)
            if vm.isBiometricAvailable {
                BiometricButton {
                    handleBiometricUnlock()
                }
                .scaleEffect(biometricPulse)
                .onAppear {
                    withAnimation(.easeInOut(duration: 2).repeatForever(autoreverses: true)) {
                        biometricPulse = 1.05
                    }
                }
                .padding(.top, 8)
            }

            Spacer()
        }
        .padding(.horizontal, 24)
        .background(
            LinearGradient(
                colors: [Color.brandPrimary.opacity(0.05), Color.clear],
                startPoint: .top,
                endPoint: .center
            )
            .ignoresSafeArea()
        )
        .loadingOverlay(
            isPresented: vm.isLoading,
            message: NSLocalizedString("pin_unlock_verifying", comment: "Verifying...")
        )
        .navigationBarBackButtonHidden()
        .onAppear {
            attemptBiometricOnAppear()
        }
    }

    // MARK: - Biometric Unlock

    private func handleBiometricUnlock() {
        // Delegate to PINViewModel.attemptBiometricUnlock() which retrieves the
        // biometric-protected PIN from Keychain (via KeychainService.retrievePINWithBiometric)
        // and uses it to decrypt device keys — no manual PIN entry needed.
        resolvedPINViewModel.attemptBiometricUnlock()
    }

    // MARK: - Auto-Biometric on Appear

    private func attemptBiometricOnAppear() {
        guard !hasAttemptedBiometric,
              appState.authService.isBiometricEnabled,
              BiometricPrompt.isAvailable else {
            return
        }
        hasAttemptedBiometric = true
        handleBiometricUnlock()
    }

    // MARK: - ViewModel Resolution

    private var resolvedPINViewModel: PINViewModel {
        if let vm = pinViewModel {
            return vm
        }
        let vm = PINViewModel(
            mode: .unlock,
            authService: appState.authService,
            onSuccess: {
                appState.didUnlock()
                // Router will auto-navigate via authStatus change
            }
        )
        DispatchQueue.main.async {
            self.pinViewModel = vm
        }
        return vm
    }
}

// MARK: - Preview

#if DEBUG
#Preview("PIN Unlock View") {
    NavigationStack {
        PINUnlockView()
            .environment(AppState(hubContext: HubContext()))
            .environment(Router())
    }
}
#endif
