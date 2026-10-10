import Foundation

// MARK: - InviteCodeParser

/// Parses an invite code out of free-form user input.
///
/// Accepts a bare UUID or any text containing one, so a volunteer can paste the
/// full invite link the admin copied from the desktop app
/// (`https://<hub>/onboarding?code=<uuid>`, see `src/client/routes/users.tsx`)
/// instead of transcribing the code by hand. Mirrors Android's
/// `InviteCodeParser` (`InviteModels.kt`) — the regex must stay byte-identical
/// across platforms.
enum InviteCodeParser {
    private static let codeRegex = try! NSRegularExpression(
        pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    )

    /// The normalized (lowercase) invite code, or nil when none was found.
    static func extractCode(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard let match = codeRegex.firstMatch(in: trimmed, range: range),
              let swiftRange = Range(match.range, in: trimmed) else {
            return nil
        }
        return String(trimmed[swiftRange]).lowercased()
    }

    /// The hub origin when the input is an invite link (`https://<hub>/…`),
    /// so pasting a link can fill the hub URL field too. Bare codes have no
    /// origin and return nil.
    static func extractHubURL(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("://"),
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme, scheme == "https",
              let host = components.host else {
            return nil
        }
        var origin = "\(scheme)://\(host)"
        if let port = components.port {
            origin += ":\(port)"
        }
        return origin
    }
}

// MARK: - EnrollmentError

/// Why invite redemption failed, mapped to the `enroll_error_*` strings.
enum EnrollmentError: Error, Equatable {
    case invalidCode
    case notFound
    case expired
    case rateLimited
    case network
    case unknown

    var localizedMessage: String {
        switch self {
        case .invalidCode:
            return NSLocalizedString("enroll_error_invalid_code", comment: "Invite code malformed")
        case .notFound:
            return NSLocalizedString("enroll_error_not_found", comment: "Invite not found")
        case .expired:
            return NSLocalizedString("enroll_error_expired", comment: "Invite expired or used")
        case .rateLimited:
            return NSLocalizedString("enroll_error_rate_limited", comment: "Too many attempts")
        case .network:
            return NSLocalizedString("enroll_error_network", comment: "Hub unreachable")
        case .unknown:
            return NSLocalizedString("enroll_error_unknown", comment: "Enroll failed")
        }
    }
}

// MARK: - InviteService

/// Enrollment via invite-code redemption (#1046, iOS counterpart of #766).
///
/// Wraps the public invite routes in `apps/worker/routes/invites.ts`:
/// - `GET /api/invites/validate/:code` — pre-flight check on the login screen.
/// - `POST /api/invites/redeem` — registers this device's identity against an
///   invite code. The request body carries its own Ed25519 token signed over
///   the nonce-less device-auth message (`createAuthTokenWithoutNonce`); after
///   a successful redemption the identity is a hub member and every subsequent
///   request authenticates with the Bearer header as usual.
///
/// Neither route is hub-scoped: the server resolves the invite's hub and
/// writes the hub membership itself, so the paths must never go through
/// `apiService.hp(_:)`.
final class InviteService {
    private let apiService: APIService
    private let cryptoService: CryptoService

    /// The path the redeem token is signed over — must match the wire path
    /// byte-for-byte or the server's `verifyAuthToken` rejects the signature.
    static let redeemPath = "/api/invites/redeem"

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    /// `GET /api/invites/validate/:code` — whether the code can still be
    /// redeemed. Public route: called before the device has keys, so it must
    /// not depend on an unlocked crypto state.
    func validate(code: String) async throws -> InviteValidationResponse {
        try await apiService.request(
            method: "GET",
            path: "/api/invites/validate/\(code)"
        )
    }

    /// Redeem an invite code for the current device identity.
    ///
    /// Requires the device keys to be generated and unlocked (the token signs
    /// with the device Ed25519 key), so this runs after PIN set. `code` may be
    /// a bare UUID or a full invite link — it is normalized before sending.
    ///
    /// - Throws: `EnrollmentError` (via `mapError`) on failure.
    func redeem(code rawCode: String) async throws {
        guard let code = InviteCodeParser.extractCode(rawCode) else {
            throw EnrollmentError.invalidCode
        }

        let token = try cryptoService.createAuthTokenWithoutNonce(
            method: "POST",
            path: Self.redeemPath
        )

        let body = RedeemInviteBody(
            code: code,
            nonce: nil,
            pubkey: token.pubkey,
            timestamp: Double(token.timestamp),
            token: token.token
        )

        // The redeem response body is `{volunteer: …}`; the client needs
        // nothing from it — membership is re-fetched via /api/auth/me after
        // onboarding completes.
        let _: EmptyResponse = try await apiService.request(
            method: "POST",
            path: Self.redeemPath,
            body: body
        )
    }

    /// Map an arbitrary failure from `redeem`/`validate` to a user-presentable
    /// enrollment error.
    static func mapError(_ error: Error) -> EnrollmentError {
        if let enrollmentError = error as? EnrollmentError {
            return enrollmentError
        }
        guard let apiError = error as? APIError else {
            return .unknown
        }
        switch apiError {
        case .requestFailed(let statusCode, _):
            switch statusCode {
            case 429: return .rateLimited
            case 404: return .notFound
            case 400, 401, 410: return .expired
            default: return .unknown
            }
        case .networkError, .noBaseURL, .invalidURL, .insecureConnection:
            return .network
        case .decodingError, .authTokenCreationFailed:
            return .unknown
        }
    }
}
