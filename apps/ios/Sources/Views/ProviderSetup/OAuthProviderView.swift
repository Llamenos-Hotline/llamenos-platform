import SwiftUI
import AuthenticationServices

// MARK: - OAuthProviderView

/// OAuth connection flow for providers that support it.
/// Opens ASWebAuthenticationSession, then polls until the callback is received.
struct OAuthProviderView: View {
    @Bindable var viewModel: ProviderSetupViewModel
    let provider: ProviderInfo
    let onConnected: () -> Void

    @State private var authSession: ASWebAuthenticationSession?
    @State private var contextProvider = ASWebAuthContextProvider()
    @State private var pollingTask: Task<Void, Never>?

    var body: some View {
        Form {
            providerHeaderSection
            connectionSection
            if viewModel.connectionStatus == .connected {
                connectedActionsSection
            }
            if let error = viewModel.error {
                errorSection(error)
            }
        }
        .navigationTitle(provider.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadStatus()
        }
        .onDisappear {
            pollingTask?.cancel()
        }
        .accessibilityIdentifier("oauth-provider-view")
    }

    // MARK: - Sections

    private var providerHeaderSection: some View {
        Section {
            HStack(spacing: 16) {
                Image(systemName: provider.icon)
                    .font(.largeTitle)
                    .foregroundStyle(Color.brandPrimary)

                VStack(alignment: .leading, spacing: 4) {
                    Text(provider.displayName)
                        .font(.brand(.headline))

                    ProviderStatusIndicator(status: viewModel.connectionStatus)
                }
                Spacer()
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private var connectionSection: some View {
        Section {
            switch viewModel.oauthPhase {
            case .idle, .waitingForBrowser:
                oauthConnectButton
            case .polling:
                pollingView
            case .complete:
                connectedView
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Label(
                        NSLocalizedString("provider_oauth_failed_label", comment: "OAuth Failed"),
                        systemImage: "xmark.circle.fill"
                    )
                    .foregroundStyle(Color.brandDestructive)
                    Text(message)
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)
                    oauthConnectButton
                }
            }
        } header: {
            Text(NSLocalizedString("provider_oauth_connection_header", comment: "Connect via OAuth"))
        } footer: {
            Text(NSLocalizedString("provider_oauth_footer", comment: "Authorize Llamenos to access your provider account securely."))
                .font(.brand(.caption))
        }
    }

    private var oauthConnectButton: some View {
        Button {
            startOAuthFlow()
        } label: {
            HStack {
                if viewModel.isConnecting {
                    ProgressView()
                        .scaleEffect(0.8)
                        .padding(.trailing, 4)
                }
                Text(L10n.format("provider_oauth_connect_button", comment: "Connect with %@", provider.displayName))
                    .font(.brand(.body))
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(viewModel.isConnecting)
        .accessibilityIdentifier("oauth-connect-button")
    }

    private var pollingView: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(NSLocalizedString("provider_oauth_waiting", comment: "Waiting for authorization..."))
                .font(.brand(.body))
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private var connectedView: some View {
        Label(
            NSLocalizedString("provider_oauth_authorized", comment: "Authorization complete"),
            systemImage: "checkmark.circle.fill"
        )
        .foregroundStyle(.green)
    }

    private var connectedActionsSection: some View {
        Section {
            Button {
                onConnected()
            } label: {
                Label(
                    NSLocalizedString("provider_select_phone_number", comment: "Select Phone Number"),
                    systemImage: "phone.badge.plus"
                )
            }
            .accessibilityIdentifier("oauth-select-number-button")

            testConnectionButton
        } header: {
            Text(NSLocalizedString("provider_next_steps_header", comment: "Next Steps"))
        }
    }

    private var testConnectionButton: some View {
        Button {
            Task { await viewModel.testConnection() }
        } label: {
            HStack {
                if viewModel.isTesting {
                    ProgressView().scaleEffect(0.8)
                } else {
                    Image(systemName: "network")
                }
                Text(NSLocalizedString("provider_test_connection", comment: "Test Connection"))
            }
        }
        .disabled(viewModel.isTesting)
        .accessibilityIdentifier("provider-test-button")
    }

    @ViewBuilder
    private func errorSection(_ message: String) -> some View {
        Section {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.brand(.footnote))
                .foregroundStyle(Color.brandDestructive)
        }
    }

    // MARK: - OAuth Flow

    private func startOAuthFlow() {
        Task {
            do {
                let authURL = try await viewModel.startOAuth()
                await MainActor.run {
                    openOAuthSession(url: authURL)
                }
            } catch {
                viewModel.error = error.localizedDescription
            }
        }
    }

    @MainActor
    private func openOAuthSession(url: URL) {
        let callbackScheme = "llamenos"
        let session = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: callbackScheme
        ) { callbackURL, error in
            if let error {
                let nsError = error as NSError
                if nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                    viewModel.oauthPhase = .idle
                } else {
                    viewModel.handleOAuthCallback(success: false, errorMessage: error.localizedDescription)
                }
                return
            }

            let queryItems = URLComponents(url: callbackURL ?? URL(string: "llamenos://")!, resolvingAgainstBaseURL: false)?.queryItems
            let status = queryItems?.first(where: { $0.name == "status" })?.value
            let csrfState = queryItems?.first(where: { $0.name == "csrf_state" })?.value
            if status == "success" {
                viewModel.handleOAuthCallback(success: true, state: csrfState)
            } else {
                let msg = queryItems?.first(where: { $0.name == "error" })?.value
                viewModel.handleOAuthCallback(success: false, state: csrfState, errorMessage: msg)
            }
        }
        session.presentationContextProvider = contextProvider
        session.prefersEphemeralWebBrowserSession = true
        session.start()
        authSession = session

        // Also start server-side polling as a fallback
        pollingTask = Task {
            await viewModel.pollOAuthStatus()
        }
    }
}

// MARK: - ASWebAuthenticationPresentationContextProviding

/// Provides the window for ASWebAuthenticationSession presentation.
@MainActor
final class ASWebAuthContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: \.isKeyWindow) ?? UIWindow()
    }
}
