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
@Observable
final class AuthViewModel {
    private let authService: AuthService
    private let apiService: APIService
    private let inviteService: InviteService

    /// Current step in the auth flow.
    var currentStep: AuthStep = .login

    /// Hub URL text field value.
    var hubURL: String = ""

    /// Invite code / invite link text field value (#1046).
    var inviteCode: String = ""

    /// Error to display to the user.
    var errorMessage: String?

    /// Invite-specific error, shown under the invite field.
    var inviteError: String?

    /// Called once an invite code passes validation — the caller (LoginView,
    /// via AppState) stashes the code for redemption after PIN set.
    private let onInviteValidated: (String) -> Void

    /// Whether an async operation is in progress.
    var isLoading: Bool = false

    init(
        authService: AuthService,
        apiService: APIService,
        inviteService: InviteService,
        onInviteValidated: @escaping (String) -> Void
    ) {
        self.authService = authService
        self.apiService = apiService
        self.inviteService = inviteService
        self.onInviteValidated = onInviteValidated
        self.hubURL = authService.hubURL ?? ""
    }

    // MARK: - Create New Identity

    /// Validate hub URL (and invite code, when one was entered) and proceed to
    /// PIN set. In the v3 model, device key generation happens atomically with
    /// PIN encryption inside PINViewModel — no device key display step.
    func createNewIdentity() async {
        errorMessage = nil
        inviteError = nil

        // An invite link carries the hub origin; adopt it when the hub field
        // was left blank so pasting the admin's link is all it takes.
        let inviteInput = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if !inviteInput.isEmpty, hubURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let linkHubURL = InviteCodeParser.extractHubURL(inviteInput) {
            hubURL = linkHubURL
        }

        guard await validateAndStoreHubURL() else { return }

        if !inviteInput.isEmpty {
            guard await validateInvite(inviteInput) else { return }
        }

        currentStep = .settingPIN
    }

    // MARK: - Invite Validation

    /// Pre-flight the invite code against `GET /api/invites/validate/:code`.
    /// Returns true when the code can still be redeemed; on success the code is
    /// handed to `onInviteValidated` for redemption after PIN set (#1046).
    private func validateInvite(_ input: String) async -> Bool {
        guard let code = InviteCodeParser.extractCode(input) else {
            inviteError = NSLocalizedString("onboarding_invalid_code", comment: "Invalid invite code")
            return false
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let result = try await inviteService.validate(code: code)
            guard result.valid else {
                switch result.error {
                case .expired:
                    inviteError = NSLocalizedString("onboarding_expired", comment: "This invite has expired")
                case .alreadyUsed:
                    inviteError = NSLocalizedString("onboarding_already_used", comment: "This invite has already been used")
                case .notFound, nil:
                    inviteError = NSLocalizedString("onboarding_invalid_code", comment: "Invalid invite code")
                }
                return false
            }
            onInviteValidated(code)
            return true
        } catch {
            // Validation is rate-limited (5/min); surface the service mapping.
            inviteError = InviteService.mapError(error).localizedMessage
            return false
        }
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
        inviteError = nil
        isLoading = false
    }
}
