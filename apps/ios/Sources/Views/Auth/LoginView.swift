import SwiftUI

// MARK: - LoginView

/// Initial login screen. Provides a hub URL text field and two paths:
/// - "Create New Identity" → generates device keys with PIN encryption
/// - "Link Device" → QR code scan for device linking via ECDH
struct LoginView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router
    @State private var viewModelBox = ViewModelBox<AuthViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        ZStack(alignment: .top) {
            // Subtle teal gradient at top
            LinearGradient(
                colors: [Color.brandPrimary.opacity(0.08), Color.clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: UIScreen.main.bounds.height * 0.15)
            .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 32) {
                    // Logo and title
                    VStack(spacing: 12) {
                        Image("Logo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 80, height: 80)
                            .accessibilityHidden(true)

                        Text(NSLocalizedString("app_name", comment: "Llamenos"))
                            .font(.brand(.largeTitle))
                            .fontWeight(.bold)

                        Text(NSLocalizedString("login_subtitle", comment: "Secure crisis response hotline"))
                            .font(.brand(.subheadline))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 40)

                    // Hub URL field
                    VStack(alignment: .leading, spacing: 8) {
                        Text(NSLocalizedString("login_hub_url_label", comment: "Hub URL"))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        TextField(
                            NSLocalizedString("login_hub_url_placeholder", comment: "https://hub.example.org"),
                            text: Binding(
                                get: { vm.hubURL },
                                set: { vm.hubURL = $0 }
                            )
                        )
                        .padding(12)
                        .background(Color.brandCard)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.brandBorder, lineWidth: 1))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("hub-url-input")
                    }

                    // Error message
                    if let error = vm.errorMessage {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .accessibilityIdentifier("login-error")
                    }

                    // Action buttons
                    VStack(spacing: 16) {
                        Button {
                            Task {
                                await vm.createNewIdentity()
                                if vm.currentStep == .settingPIN {
                                    router.showPINSet()
                                }
                            }
                        } label: {
                            Text(NSLocalizedString("login_create_identity", comment: "Create New Identity"))
                                .fontWeight(.semibold)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color.brandPrimary)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.isLoading)
                        .accessibilityIdentifier("create-identity")

                        Button {
                            router.showDeviceLink()
                        } label: {
                            Label(
                                NSLocalizedString("login_link_device", comment: "Link from Another Device"),
                                systemImage: "qrcode.viewfinder"
                            )
                            .fontWeight(.medium)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.brandPrimary, lineWidth: 1.5))
                            .foregroundStyle(Color.brandPrimary)
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.isLoading)
                        .accessibilityIdentifier("link-device")
                    }

                    // Security tagline
                    HStack(spacing: 6) {
                        Image(systemName: "lock.shield")
                            .font(.brand(.caption))
                        Text(NSLocalizedString("login_encrypted_tagline", comment: "End-to-end encrypted"))
                            .font(.brand(.caption))
                    }
                    .foregroundStyle(Color.brandMutedForeground)

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 24)
            }
        }
        .navigationBarBackButtonHidden()
    }

    // MARK: - ViewModel Resolution

    /// Lazily creates the AuthViewModel using the AppState services.
    private var resolvedViewModel: AuthViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        let vm = AuthViewModel(authService: appState.authService, apiService: appState.apiService)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Login") {
    NavigationStack {
        LoginView()
            .environment(AppState(hubContext: HubContext()))
            .environment(Router())
    }
}
#endif
