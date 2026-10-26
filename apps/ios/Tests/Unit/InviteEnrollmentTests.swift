import Foundation
import XCTest
@testable import Llamenos

// MARK: - InviteStubURLProtocol

/// Answers invite-route requests from a handler and records what it saw. Registered per
/// session (protocolClasses), never globally, so no other suite's traffic reaches it.
private final class InviteStubURLProtocol: URLProtocol {
    struct Seen {
        let method: String
        let path: String
        let authorization: String?
        let body: [String: Any]
    }

    enum Reply {
        case status(Int, String)
        case transportError
    }

    private static let lock = NSLock()
    private static var handler: ((Seen) -> Reply)?
    private static var seen: [Seen] = []

    static func reset(_ handler: ((Seen) -> Reply)? = nil) {
        lock.lock(); defer { lock.unlock() }
        self.handler = handler
        seen = []
    }

    static func requests() -> [Seen] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let data = request.httpBody ?? request.httpBodyStream.map(Self.readStream) ?? Data()
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let entry = Seen(
            method: request.httpMethod ?? "",
            path: request.url?.path ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: body
        )

        Self.lock.lock()
        Self.seen.append(entry)
        let reply = Self.handler?(entry) ?? .transportError
        Self.lock.unlock()

        switch reply {
        case .transportError:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        case .status(let status, let json):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

// MARK: - InviteCodeParserTests

final class InviteCodeParserTests: XCTestCase {
    private let code = "3f6f1c2a-9b7d-4e1f-8a55-0c2d9e4b7a10"

    func testBareCodeIsAccepted() {
        XCTAssertEqual(InviteCodeParser.parse(code), ParsedInvite(code: code, hubURL: nil))
    }

    func testCodeIsTrimmedAndLowercased() {
        XCTAssertEqual(
            InviteCodeParser.parse("  \(code.uppercased())\n"),
            ParsedInvite(code: code, hubURL: nil)
        )
    }

    func testInviteLinkYieldsTheCodeAndTheHubItCameFrom() {
        XCTAssertEqual(
            InviteCodeParser.parse("https://hub.example.org/onboarding?code=\(code)"),
            ParsedInvite(code: code, hubURL: "https://hub.example.org")
        )
        XCTAssertEqual(
            InviteCodeParser.parse("http://localhost:3000/onboarding?code=\(code)"),
            ParsedInvite(code: code, hubURL: "http://localhost:3000")
        )
    }

    func testDeepLinkYieldsTheCodeAndNoHub() {
        XCTAssertEqual(
            InviteCodeParser.parse("llamenos://hub-invite?token=\(code)"),
            ParsedInvite(code: code, hubURL: nil)
        )
    }

    func testAnythingElseIsNotAnInvite() {
        for input in [
            "", "   ", "not-a-code", "3f6f1c2a", "https://hub.example.org/onboarding",
            "https://hub.example.org/onboarding?code=nope", "llamenos://settings?token=\(code)",
            "ftp://hub.example.org/?code=\(code)", "prefix \(code)",
        ] {
            XCTAssertNil(InviteCodeParser.parse(input), "\(input.debugDescription) is not an invite")
        }
    }
}

// MARK: - InviteEnrollmentTests

/// #1046 — a new device enrols by invite: the code is validated before any key exists, then
/// redeemed with the device's own signature once the PIN screen has created the keys.
@MainActor
final class InviteEnrollmentTests: XCTestCase {
    private let code = "3f6f1c2a-9b7d-4e1f-8a55-0c2d9e4b7a10"

    private var crypto: CryptoService!
    private var api: APIService!
    private var enrollment: InviteEnrollmentService!

    override func setUp() async throws {
        try await super.setUp()
        InviteStubURLProtocol.reset()

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [InviteStubURLProtocol.self]
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never

        crypto = CryptoService()
        crypto.lock()
        api = APIService(cryptoService: crypto, hubContext: HubContext(), sessionConfiguration: config)
        api.configure(baseURL: URL(string: "https://hub.example.org")!)
        enrollment = InviteEnrollmentService(apiService: api, cryptoService: crypto)
    }

    override func tearDown() async throws {
        crypto.lock()
        enrollment = nil
        api = nil
        crypto = nil
        InviteStubURLProtocol.reset()
        try await super.tearDown()
    }

    private func unlock() throws {
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        XCTAssertTrue(crypto.isUnlocked)
    }

    private func localized(_ key: String) -> String {
        NSLocalizedString(key, comment: "")
    }

    private func validation(_ json: String) {
        InviteStubURLProtocol.reset { _ in .status(200, json) }
    }

    // MARK: - Validate

    func testNoInviteEnteredSendsNothingAndIsNotAnError() async {
        enrollment.input = "  "

        let error = await enrollment.validate()

        XCTAssertNil(error)
        XCTAssertFalse(enrollment.hasPendingInvite)
        XCTAssertTrue(InviteStubURLProtocol.requests().isEmpty)
    }

    func testValidInviteIsCheckedUnsignedAndKeptPending() async throws {
        validation(#"{"valid":true,"name":"Ana","roleIds":["role-volunteer"]}"#)
        enrollment.input = "https://hub.example.org/onboarding?code=\(code.uppercased())"

        let error = await enrollment.validate()

        XCTAssertNil(error)
        XCTAssertTrue(enrollment.hasPendingInvite)
        let request = try XCTUnwrap(InviteStubURLProtocol.requests().first)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/api/invites/validate/\(code)")
        XCTAssertNil(request.authorization, "a public route has no identity to sign with")
    }

    func testUnknownCodeIsRefusedWithInvalidCode() async {
        validation(#"{"valid":false,"error":"not_found"}"#)
        enrollment.input = code

        let error = await enrollment.validate()

        XCTAssertEqual(error, localized("onboarding_invalid_code"))
        XCTAssertNotEqual(error, "onboarding_invalid_code", "the key must resolve to its text")
        XCTAssertFalse(enrollment.hasPendingInvite)
    }

    func testMalformedInputIsRefusedWithoutAskingTheHub() async {
        enrollment.input = "not-an-invite"

        let error = await enrollment.validate()

        XCTAssertEqual(error, localized("onboarding_invalid_code"))
        XCTAssertTrue(InviteStubURLProtocol.requests().isEmpty)
    }

    func testUsedAndExpiredInvitesSaySoDistinctly() async {
        enrollment.input = code

        validation(#"{"valid":false,"error":"already_used"}"#)
        let used = await enrollment.validate()
        validation(#"{"valid":false,"error":"expired"}"#)
        let expired = await enrollment.validate()

        XCTAssertEqual(used, localized("onboarding_already_used"))
        XCTAssertEqual(expired, localized("onboarding_expired"))
        XCTAssertNotEqual(used, expired)
        XCTAssertFalse(enrollment.hasPendingInvite)
    }

    func testThrottledOrUnreachableHubDoesNotBlameTheCode() async {
        enrollment.input = code

        InviteStubURLProtocol.reset { _ in .status(429, #"{"error":"Too many requests"}"#) }
        let throttled = await enrollment.validate()
        InviteStubURLProtocol.reset { _ in .status(503, "{}") }
        let unwell = await enrollment.validate()
        InviteStubURLProtocol.reset { _ in .transportError }
        let offline = await enrollment.validate()

        XCTAssertEqual(throttled, localized("enroll_error_rate_limited"))
        XCTAssertEqual(unwell, localized("onboarding_validation_unavailable"))
        XCTAssertEqual(offline, localized("onboarding_validation_unavailable"))
        XCTAssertNotEqual(throttled, localized("onboarding_invalid_code"))
    }

    // MARK: - Redeem

    func testWithoutAnInviteRedeemIsANoOp() async throws {
        try unlock()

        let redeemed = await enrollment.redeem()

        XCTAssertTrue(redeemed)
        XCTAssertTrue(InviteStubURLProtocol.requests().isEmpty)
    }

    func testRedeemPostsTheCodeAndTheDevicesOwnSignedToken() async throws {
        validation(#"{"valid":true}"#)
        enrollment.input = code
        _ = await enrollment.validate()
        try unlock()
        InviteStubURLProtocol.reset { _ in .status(200, #"{"volunteer":{"pubkey":"x"}}"#) }

        let redeemed = await enrollment.redeem()

        XCTAssertTrue(redeemed)
        XCTAssertFalse(enrollment.hasPendingInvite)
        XCTAssertNil(enrollment.redeemError)
        let request = try XCTUnwrap(InviteStubURLProtocol.requests().first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/invites/redeem")
        XCTAssertNil(request.authorization, "the redeem body authenticates itself; no header rides along")
        XCTAssertEqual(request.body["code"] as? String, code)
        XCTAssertEqual(request.body["pubkey"] as? String, crypto.signingPubkeyHex)
        XCTAssertFalse((request.body["token"] as? String ?? "").isEmpty)
        XCTAssertNotNil(request.body["timestamp"] as? Double)
        XCTAssertFalse((request.body["nonce"] as? String ?? "").isEmpty, "the signed message carried a nonce")
        XCTAssertEqual(request.body.count, 5, "no role, hub or other grant rides on the request: \(request.body)")
    }

    func testFailedRedeemKeepsTheInviteForARetryWithAFreshSignature() async throws {
        validation(#"{"valid":true}"#)
        enrollment.input = code
        _ = await enrollment.validate()
        try unlock()

        InviteStubURLProtocol.reset { _ in .status(429, "{}") }
        let first = await enrollment.redeem()
        XCTAssertFalse(first)
        XCTAssertEqual(enrollment.redeemError, localized("enroll_error_rate_limited"))
        XCTAssertTrue(enrollment.hasPendingInvite)

        InviteStubURLProtocol.reset { _ in .status(200, "{}") }
        let second = await enrollment.redeem()
        XCTAssertTrue(second)
        XCTAssertNil(enrollment.redeemError)
        XCTAssertFalse(enrollment.hasPendingInvite)
    }

    func testRedeemRefusedAsUsedSaysAskForANewInvite() async throws {
        validation(#"{"valid":true}"#)
        enrollment.input = code
        _ = await enrollment.validate()
        try unlock()
        InviteStubURLProtocol.reset { _ in .status(400, #"{"error":"Invalid, expired, or already-used invite code"}"#) }

        let redeemed = await enrollment.redeem()

        XCTAssertFalse(redeemed)
        XCTAssertEqual(enrollment.redeemError, localized("enroll_error_expired"))
    }

    func testARedeemThatLandedButWasNeverAnsweredIsNotReportedAsAFailure() async throws {
        validation(#"{"valid":true}"#)
        enrollment.input = code
        _ = await enrollment.validate()
        try unlock()

        // The request reaches the hub, the response never reaches the device.
        InviteStubURLProtocol.reset { _ in .transportError }
        let first = await enrollment.redeem()
        XCTAssertFalse(first)
        XCTAssertEqual(enrollment.redeemError, localized("enroll_error_network"))

        // The retry finds the invite used — but the hub knows this device.
        InviteStubURLProtocol.reset { request in
            request.path == "/api/invites/redeem"
                ? .status(400, #"{"error":"Invalid, expired, or already-used invite code"}"#)
                : .status(200, #"{"hubs":[]}"#)
        }
        let second = await enrollment.redeem()

        XCTAssertTrue(second, "the device is a member; telling the user it failed would strand them")
        let paths = InviteStubURLProtocol.requests().map(\.path)
        XCTAssertEqual(paths, ["/api/invites/redeem", "/api/hubs"])
        XCTAssertTrue(
            InviteStubURLProtocol.requests().last?.authorization?.hasPrefix("Bearer ") == true,
            "membership is proven by a signed request, not by trusting the 400"
        )
    }

    func testAUsedInviteThatDidNotLandHereStaysARefusal() async throws {
        validation(#"{"valid":true}"#)
        enrollment.input = code
        _ = await enrollment.validate()
        try unlock()

        InviteStubURLProtocol.reset { _ in .transportError }
        _ = await enrollment.redeem()
        // Someone else used it: the hub refuses the retry and does not know this device.
        InviteStubURLProtocol.reset { request in
            request.path == "/api/invites/redeem"
                ? .status(400, "{}")
                : .status(401, #"{"error":"unknown"}"#)
        }

        let redeemed = await enrollment.redeem()

        XCTAssertFalse(redeemed)
        XCTAssertEqual(enrollment.redeemError, localized("enroll_error_expired"))
    }

    func testResetForgetsTheInvite() async throws {
        validation(#"{"valid":true}"#)
        enrollment.input = code
        _ = await enrollment.validate()

        enrollment.reset()

        XCTAssertFalse(enrollment.hasPendingInvite)
        XCTAssertEqual(enrollment.input, "")
        XCTAssertNil(enrollment.redeemError)
    }
}

// MARK: - InviteHubSelectionTests

/// An invite link names a hub, and a link is whoever sent it. These pin that it can only
/// fill an empty hub field, where the user sees it, and never replace a hub they chose.
@MainActor
final class InviteHubSelectionTests: XCTestCase {
    private let code = "3f6f1c2a-9b7d-4e1f-8a55-0c2d9e4b7a10"

    private func makeViewModel(hubURL: String) -> AuthViewModel {
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: HubContext())
        let auth = AuthService(cryptoService: crypto, keychainService: KeychainService())
        let viewModel = AuthViewModel(
            authService: auth,
            apiService: api,
            inviteEnrollment: InviteEnrollmentService(apiService: api, cryptoService: crypto)
        )
        viewModel.hubURL = hubURL
        return viewModel
    }

    func testPastedLinkFillsAnEmptyHubField() {
        let viewModel = makeViewModel(hubURL: "")
        viewModel.inviteEnrollment.input = "https://hub.example.org/onboarding?code=\(code)"

        viewModel.inviteInputChanged()

        XCTAssertEqual(viewModel.hubURL, "https://hub.example.org")
    }

    func testPastedLinkNeverReplacesATypedHub() {
        let viewModel = makeViewModel(hubURL: "https://my-hub.example.org")
        viewModel.inviteEnrollment.input = "https://evil.example/onboarding?code=\(code)"

        viewModel.inviteInputChanged()

        XCTAssertEqual(viewModel.hubURL, "https://my-hub.example.org")
    }

    func testABareCodeLeavesTheHubFieldAlone() {
        let viewModel = makeViewModel(hubURL: "")
        viewModel.inviteEnrollment.input = code

        viewModel.inviteInputChanged()

        XCTAssertEqual(viewModel.hubURL, "")
    }
}

// MARK: - HubURLLocalhostTests

/// Plain HTTP is allowed to the developer's own machine and nowhere else. The exemption
/// is decided by the URL's host, so a remote URL that merely mentions "localhost" gets no
/// cleartext connection (the invite flow now sends a signed redemption to this URL).
@MainActor
final class HubURLLocalhostTests: XCTestCase {
    private func api() -> APIService {
        APIService(cryptoService: CryptoService(), hubContext: HubContext())
    }

    func testRemoteHostThatMentionsLocalhostIsStillHttpsOnly() {
        for url in ["http://evil.example/localhost", "http://localhost.evil.example", "http://evil.example/?next=127.0.0.1"] {
            XCTAssertThrowsError(try api().configure(hubURLString: url), "\(url) must not be allowed over HTTP")
        }
    }

    func testRemoteHostWithoutASchemeGetsHttps() throws {
        let service = api()
        try service.configure(hubURLString: "evil.example/localhost")
        XCTAssertEqual(service.baseURL?.scheme, "https")
    }

    func testLoopbackStaysAllowedOverHttp() throws {
        let service = api()
        try service.configure(hubURLString: "http://localhost:3000")
        XCTAssertEqual(service.baseURL?.absoluteString, "http://localhost:3000")
        try service.configure(hubURLString: "127.0.0.1:3000")
        XCTAssertEqual(service.baseURL?.absoluteString, "http://127.0.0.1:3000")
    }
}
