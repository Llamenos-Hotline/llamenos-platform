import SwiftUI

/// PIN/passphrase set screen: user creates a credential (PIN or passphrase) using a secure text field.
/// This screen is shown during onboarding after identity creation or import.
/// After successful credential set and confirmation, the identity is encrypted and
/// persisted to the Keychain via PINViewModel.
struct PINSetView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router
    @State private var pinViewModel: PINViewModel?
    @State private var shakeOnError = false
    @State private var lockRotation: Double = 0

    var body: some View {
        // Keys exist once the PIN is confirmed; from then on this screen is about joining
        // the hub, not about the PIN.
        if appState.inviteEnrollment.isRedeeming || appState.inviteEnrollment.redeemError != nil {
            InviteRedeemView()
        } else {
            pinEntry
        }
    }

    private var pinEntry: some View {
        let vm = resolvedPINViewModel

        return VStack(spacing: 24) {
            StepIndicator(totalSteps: 2, currentStep: 2)
                .padding(.top, 8)

            // Header
            VStack(spacing: 12) {
                Image(systemName: vm.phase == .confirm ? "lock.fill" : "lock.open.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(Color.brandPrimary)
                    .rotationEffect(.degrees(lockRotation))
                    .accessibilityHidden(true)
                    .animation(.easeInOut, value: vm.phase)

                Text(vm.titleText)
                    .font(.brand(.title2))
                    .fontWeight(.bold)
                    .contentTransition(.opacity)
                    .animation(.easeInOut, value: vm.phase)

                Text(vm.subtitleText)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)
                    .animation(.easeInOut, value: vm.phase)
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

            // Credential input (secure text field for PIN or passphrase)
            SecureField(
                NSLocalizedString("pin_placeholder", comment: "PIN or passphrase (8+ characters)"),
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

            Button(NSLocalizedString("common_continue", comment: "Continue")) {
                vm.onPINComplete(vm.pin)
            }
            .buttonStyle(.borderedProminent)
            .disabled(vm.pin.count < 8)
            .accessibilityIdentifier("pin-submit")

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .onChange(of: vm.phase) { _, newPhase in
            if newPhase == .confirm {
                withAnimation(.spring()) { lockRotation = 360 }
            }
        }
        .onChange(of: vm.errorMessage) { _, newValue in
            if newValue != nil {
                shakeOnError = true
            }
        }
        .loadingOverlay(
            isPresented: vm.isLoading,
            message: NSLocalizedString("pin_set_encrypting", comment: "Encrypting your key...")
        )
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    router.goBack()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityIdentifier("back-button")
                .accessibilityLabel(NSLocalizedString("navigation_back", comment: "Back"))
            }
        }
    }

    // MARK: - ViewModel Resolution

    private var resolvedPINViewModel: PINViewModel {
        if let vm = pinViewModel {
            return vm
        }
        let vm = PINViewModel(
            mode: .set,
            authService: appState.authService,
            maxLength: 128,
            onSuccess: {
                Task { await appState.completeEnrollment() }
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
#Preview("PIN Set View") {
    NavigationStack {
        PINSetView()
            .environment(AppState(hubContext: HubContext()))
            .environment(Router())
    }
}
#endif
