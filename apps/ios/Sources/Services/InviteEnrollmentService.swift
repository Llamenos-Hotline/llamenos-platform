import Foundation

// MARK: - ParsedInvite

/// An invite code read out of whatever the user typed, pasted or tapped.
struct ParsedInvite: Equatable {
    /// The invite code, lowercased (the server compares the canonical UUID form).
    let code: String
    /// The hub the link came from (its http(s) origin), when the input was a link.
    let hubURL: String?
}

// MARK: - InviteCodeParser

enum InviteCodeParser {
    /// Accepts a bare invite code, an invite link carrying it as `?code=` (what the
    /// admin's "copy invite link" produces, `https://<hub>/onboarding?code=<uuid>`), or a
    /// `llamenos://hub-invite?token=` deep link. Anything else is not an invite.
    static func parse(_ input: String) -> ParsedInvite? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let code = asInviteCode(trimmed) { return ParsedInvite(code: code, hubURL: nil) }

        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased()
        else { return nil }
        let items = components.queryItems ?? []

        switch scheme {
        case "https", "http":
            guard let value = items.first(where: { $0.name == "code" })?.value,
                  let code = asInviteCode(value),
                  let host = components.host
            else { return nil }
            let port = components.port.map { ":\($0)" } ?? ""
            return ParsedInvite(code: code, hubURL: "\(scheme)://\(host)\(port)")
        case "llamenos":
            guard components.host == "hub-invite",
                  let value = items.first(where: { $0.name == "token" || $0.name == "code" })?.value,
                  let code = asInviteCode(value)
            else { return nil }
            return ParsedInvite(code: code, hubURL: nil)
        default:
            return nil
        }
    }

    private static func asInviteCode(_ value: String) -> String? {
        guard let uuid = UUID(uuidString: value) else { return nil }
        let canonical = uuid.uuidString.lowercased()
        return canonical == value.lowercased() ? canonical : nil
    }
}

// MARK: - InviteEnrollmentService

/// Enrolment by invite: Login (validate) → PIN set (creates the device keys) → redeem.
///
/// The invite has to outlive three screens, and redeeming needs the device keys the PIN
/// screen creates, so this lives on `AppState` rather than on any one view model.
///
/// It grants nothing. Membership, and the roles that come with it, are written by the
/// server from the hub the invite names; this service only presents the invite and the
/// device's signature over the request.
@MainActor
@Observable
final class InviteEnrollmentService {
    private static let redeemPath = "/api/invites/redeem"

    private let apiService: APIService
    private let cryptoService: CryptoService

    /// What the login screen's invite field holds. A deep link fills it too.
    var input: String = ""

    /// The validated invite waiting to be redeemed, nil when there is none.
    private(set) var code: String?

    /// Whether a redemption request is in flight.
    private(set) var isRedeeming = false

    /// Why the last redemption failed, localized. Cleared when a new attempt starts.
    private(set) var redeemError: String?

    /// The last redemption's outcome never reached the device, so the request may have landed.
    private var outcomeUnknown = false

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    /// Whether an invite was validated and still has to be redeemed.
    var hasPendingInvite: Bool { code != nil }

    // MARK: - Validate

    /// Check the entered invite against the configured hub before any key exists.
    ///
    /// An empty field means no invite: returns nil and leaves `code` unset. Returns a
    /// localized message when the input cannot be redeemed, nil when it can.
    func validate() async -> String? {
        code = nil
        redeemError = nil
        outcomeUnknown = false

        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let parsed = InviteCodeParser.parse(trimmed) else {
            return NSLocalizedString("onboarding_invalid_code", comment: "Invalid invite code")
        }

        do {
            let result: InviteValidationResponse = try await apiService.publicRequest(
                method: "GET", path: "/api/invites/validate/\(parsed.code)"
            )
            if result.valid {
                code = parsed.code
                return nil
            }
            switch result.error {
            case .expired:
                return NSLocalizedString("onboarding_expired", comment: "This invite has expired")
            case .alreadyUsed:
                return NSLocalizedString("onboarding_already_used", comment: "This invite has already been used")
            case .notFound, .none:
                return NSLocalizedString("onboarding_invalid_code", comment: "Invalid invite code")
            }
        } catch {
            return Self.message(for: error, validating: true)
        }
    }

    // MARK: - Redeem

    /// Redeem the validated invite with the device keys just created.
    ///
    /// Returns true once the device is a hub member, or when there was no invite to redeem.
    /// On false, `redeemError` says why and the invite stays pending for a retry.
    @discardableResult
    func redeem() async -> Bool {
        guard let code else { return true }
        guard !isRedeeming else { return false }
        isRedeeming = true
        redeemError = nil
        defer { isRedeeming = false }
        let earlierOutcomeUnknown = outcomeUnknown

        do {
            let token = try cryptoService.createAuthToken(method: "POST", path: Self.redeemPath)
            let body = RedeemInviteBody(
                code: code,
                nonce: token.nonce,
                pubkey: token.pubkey,
                timestamp: Double(token.timestamp),
                token: token.token
            )
            let _: EmptyResponse = try await apiService.publicRequest(
                method: "POST", path: Self.redeemPath, wireBody: body
            )
            finish()
            return true
        } catch {
            outcomeUnknown = Self.isAmbiguous(error)
            if earlierOutcomeUnknown, await refusedBecauseAlreadyEnrolled(error) {
                finish()
                return true
            }
            redeemError = Self.message(for: error, validating: false)
            return false
        }
    }

    /// A redemption that lands but whose response never arrives leaves the invite used. The
    /// retry is then refused as a used invite although the device is already a member, so
    /// before reporting that, ask the hub: it only answers a signed request from a user it
    /// knows.
    private func refusedBecauseAlreadyEnrolled(_ error: Error) async -> Bool {
        guard case APIError.requestFailed(let status, _) = error, status == 400 else { return false }
        do {
            let _: HubsListResponse = try await apiService.request(method: "GET", path: "/api/hubs", body: nil)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Lifecycle

    /// The user chose to continue without enrolling: forget the invite.
    func abandon() {
        reset()
    }

    /// Forget the invite and its state (enrolment done, logout, wipe).
    func reset() {
        input = ""
        code = nil
        isRedeeming = false
        redeemError = nil
        outcomeUnknown = false
    }

    private func finish() {
        input = ""
        code = nil
        redeemError = nil
        outcomeUnknown = false
    }

    // MARK: - Errors

    /// A transport failure or a 5xx: the hub could not answer, which says nothing about the
    /// invite. A 5xx also leaves a redemption's outcome unknown.
    private static func isAmbiguous(_ error: Error) -> Bool {
        switch error {
        case APIError.networkError:
            return true
        case APIError.requestFailed(let status, _):
            return status >= 500
        default:
            return false
        }
    }

    /// The message for a failed invite call.
    ///
    /// A throttled or unreachable hub is not a judgement on the invite. Validation is rate
    /// limited per client address (`apps/worker/routes/invites.ts`), so answering that 429
    /// with "Invalid invite code" would blame a code the server never read, and retyping it
    /// would spend more of the same allowance.
    static func message(for error: Error, validating: Bool) -> String {
        switch error {
        case APIError.networkError:
            return validating
                ? NSLocalizedString("onboarding_validation_unavailable", comment: "Couldn't validate your invite right now")
                : NSLocalizedString("enroll_error_network", comment: "Couldn't reach the hub")
        case APIError.requestFailed(let status, _) where status == 429:
            return NSLocalizedString("enroll_error_rate_limited", comment: "Too many attempts")
        case APIError.requestFailed(let status, _) where status >= 500:
            return validating
                ? NSLocalizedString("onboarding_validation_unavailable", comment: "Couldn't validate your invite right now")
                : NSLocalizedString("enroll_error_network", comment: "Couldn't reach the hub")
        case APIError.requestFailed(let status, _) where !validating && status == 400:
            // The claim found the invite expired or already used; ask the hub for another.
            return NSLocalizedString("enroll_error_expired", comment: "This invite has expired or was already used")
        default:
            return validating
                ? NSLocalizedString("onboarding_invalid_code", comment: "Invalid invite code")
                : NSLocalizedString("enroll_error_unknown", comment: "Something went wrong while enrolling")
        }
    }
}
