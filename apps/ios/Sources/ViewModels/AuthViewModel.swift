import Foundation

// MARK: - AuthStep

/// Steps in the login/onboarding flow.
/// V3 device key model: no device key to show. Create identity → set PIN → done.
enum AuthStep: Equatable {
    /// Initial login screen.
    case login
    /// User is setting their PIN (generates device keys atomically).
    case settingPIN
    /// Complete — ready to proceed to dashboard.
    case complete
}

// MARK: - AuthViewModel

/// View model for the login and onboarding flow. Manages the state machine for
/// identity creation and hub URL configuration. PIN handling is delegated to PINViewModel.
///
/// V3: No more device key display or import. Device keys are generated atomically with
/// PIN encryption. Multi-device support uses device linking (QR + ECDH) instead of
/// device key backup/import.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class AuthViewModel {
    private let authService: AuthService
    private let apiService: APIService

    /// Current step in the auth flow.
    var currentStep: AuthStep = .login

    /// Hub URL text field value.
    var hubURL: String = ""

    /// Error to display to the user.
    var errorMessage: String?

    /// Whether an async operation is in progress.
    var isLoading: Bool = false

    init(authService: AuthService, apiService: APIService) {
        self.authService = authService
        self.apiService = apiService
        self.hubURL = authService.hubURL ?? ""
    }

    // MARK: - Create New Identity

    /// Validate hub URL and proceed to PIN set.
    /// In the v3 model, device key generation happens atomically with PIN encryption
    /// inside PINViewModel — no device key display step.
    func createNewIdentity() async {
        errorMessage = nil
        guard await validateAndStoreHubURL() else { return }
        currentStep = .settingPIN
    }

    // MARK: - Hub URL

    /// Validate hub URL format, persist it, and test connectivity.
    /// Returns true if the hub is reachable, false otherwise (sets errorMessage).
    @discardableResult
    private func validateAndStoreHubURL() async -> Bool {
        let trimmed = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = NSLocalizedString("error_hub_url_empty", comment: "Please enter the hub URL")
            return false
        }

        do {
            try apiService.configure(hubURLString: trimmed)
            try authService.setHubURL(apiService.baseURL?.absoluteString ?? trimmed)
        } catch {
            errorMessage = error.localizedDescription
            return false
        }

        // Skip connectivity check in test mode (XCUITests use fake hub URLs)
        if ProcessInfo.processInfo.arguments.contains("--test-skip-hub-validation") {
            return true
        }

        // Test actual connectivity
        isLoading = true
        let reachable = await apiService.validateConnection()
        isLoading = false

        if !reachable {
            errorMessage = NSLocalizedString(
                "error_hub_unreachable",
                comment: "Could not connect to the hub. Check the URL and try again."
            )
            return false
        }

        return true
    }

    // MARK: - Reset

    /// Reset the view model to the initial login state.
    func reset() {
        currentStep = .login
        errorMessage = nil
        isLoading = false
    }
}
