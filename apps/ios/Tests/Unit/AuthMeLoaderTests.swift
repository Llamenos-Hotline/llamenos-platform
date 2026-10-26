import Foundation
import XCTest
@testable import Llamenos

// MARK: - AuthMeStubURLProtocol

/// Answers `GET /api/auth/me` from a scripted queue and records how many requests
/// arrived. Registered per session (protocolClasses), never globally. When the script
/// runs out the last reply repeats, like a server that stays in the state it is in.
private final class AuthMeStubURLProtocol: URLProtocol {
    enum Reply {
        case status(Int)
        case timeout
        case profile(permissions: [String])
    }

    private static let lock = NSLock()
    private static var script: [Reply] = []
    private static var count = 0

    static func reset(_ script: [Reply]) {
        lock.lock(); defer { lock.unlock() }
        self.script = script
        count = 0
    }

    /// Replace what the server answers from now on, keeping the request count.
    static func respond(_ script: [Reply]) {
        lock.lock(); defer { lock.unlock() }
        self.script = script
    }

    static var requestCount: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.count += 1
        let reply = Self.script.count > 1 ? Self.script.removeFirst() : (Self.script.first ?? .status(200))
        Self.lock.unlock()

        switch reply {
        case .timeout:
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
        case .status(let code):
            respond(code: code, body: #"{"error":"stubbed"}"#)
        case .profile(let permissions):
            let list = permissions.map { "\"\($0)\"" }.joined(separator: ",")
            respond(code: 200, body: #"{"pubkey":"aa","roles":["custom-role"],"permissions":[\#(list)]}"#)
        }
    }

    private func respond(code: Int, body: String) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: code,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - AuthMeLoaderTests

/// A failed permission refresh must never change what the user may do. These drive the
/// real `AuthMeLoader` → `APIService` path against a stubbed socket and assert on the
/// permission set the UI gates read: a transient failure (timeout, 5xx, 401) keeps it
/// and is surfaced; only a 403 changes it.
@MainActor
final class AuthMeLoaderTests: XCTestCase {

    private static let adminPermissions = ["settings:manage", "calls:answer"]

    private var permissions: PermissionService!
    private var loader: AuthMeLoader!

    override func setUp() async throws {
        try await super.setUp()
        AuthMeStubURLProtocol.reset([])

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AuthMeStubURLProtocol.self]
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.httpCookieStorage = nil

        let crypto = CryptoService()
        crypto.lock()
        let api = APIService(cryptoService: crypto, hubContext: HubContext(), sessionConfiguration: config)
        api.configure(baseURL: URL(string: "https://hub.example.org")!)
        permissions = PermissionService()
        loader = AuthMeLoader(apiService: api, permissionService: permissions, retryDelays: [.milliseconds(20)])
    }

    override func tearDown() async throws {
        loader.cancel()
        loader = nil
        permissions = nil
        AuthMeStubURLProtocol.reset([])
        try await super.tearDown()
    }

    /// Polls a condition — no fixed sleeps; a retry's timing is not the thing under test.
    private func waitUntil(_ description: String, timeout: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), "timed out waiting for: \(description)")
    }

    /// The admin the server last described, as the app holds it mid-shift.
    private func holdAdminPermissions() {
        permissions.update(permissions: Self.adminPermissions)
        XCTAssertTrue(permissions.isAdmin)
    }

    // MARK: - Transient failures keep the permissions

    func testTimeoutKeepsPermissionsSurfacesTheFailureAndRetriesUntilAnswered() async {
        holdAdminPermissions()
        AuthMeStubURLProtocol.reset([.timeout, .timeout, .profile(permissions: Self.adminPermissions)])

        let refresh = Task { await loader.refresh() }
        await waitUntil("two failed attempts") { AuthMeStubURLProtocol.requestCount >= 2 }

        XCTAssertTrue(permissions.isAdmin, "a timeout says nothing about authority; the admin must stay an admin")
        XCTAssertEqual(permissions.permissions, Self.adminPermissions)

        guard case .loaded = await refresh.value else { return XCTFail("the third attempt answers") }
        XCTAssertEqual(AuthMeStubURLProtocol.requestCount, 3)
        XCTAssertNil(permissions.refreshFailure, "an answer clears the failure")
        XCTAssertTrue(permissions.isAdmin)
    }

    func testServerErrorKeepsPermissionsAndIsSurfacedAsKeptLastKnown() async {
        holdAdminPermissions()
        AuthMeStubURLProtocol.reset([.status(503)])

        let refresh = Task { await loader.refresh() }
        await waitUntil("a failure is recorded") { self.permissions.refreshFailure != nil }

        XCTAssertEqual(permissions.refreshFailure, .keptLastKnown)
        XCTAssertTrue(permissions.isAdmin, "a 5xx must not strip the admin's permissions")

        loader.cancel()
        _ = await refresh.value
    }

    func testUnauthorizedIsNotAnAnswerAboutPermissions() async {
        // The auth layer reports "could not check" as 401 while the database is down (#2173).
        holdAdminPermissions()
        AuthMeStubURLProtocol.reset([.status(401)])

        let refresh = Task { await loader.refresh() }
        await waitUntil("retried after the 401") { AuthMeStubURLProtocol.requestCount >= 2 }

        XCTAssertTrue(permissions.isAdmin)
        XCTAssertEqual(permissions.refreshFailure, .keptLastKnown)

        loader.cancel()
        _ = await refresh.value
    }

    func testFailureBeforeAnyAnswerFailsClosedAndSaysSo() async {
        AuthMeStubURLProtocol.reset([.status(500)])

        let refresh = Task { await loader.refresh() }
        await waitUntil("a failure is recorded") { self.permissions.refreshFailure != nil }

        XCTAssertEqual(permissions.refreshFailure, .noneKnown)
        XCTAssertTrue(permissions.permissions.isEmpty, "with no answer there is nothing to keep")
        XCTAssertFalse(permissions.isAdmin)

        AuthMeStubURLProtocol.respond([.profile(permissions: Self.adminPermissions)])
        guard case .loaded = await refresh.value else { return XCTFail("recovers once the server answers") }
        XCTAssertNil(permissions.refreshFailure)
        XCTAssertTrue(permissions.isAdmin)
    }

    // MARK: - A real answer changes the set

    func testForbiddenIsAnAnswerAndRemovesThePermissionsWithoutRetrying() async {
        holdAdminPermissions()
        AuthMeStubURLProtocol.reset([.status(403)])

        guard case .denied = await loader.refresh() else { return XCTFail("a 403 settles the refresh") }

        XCTAssertEqual(AuthMeStubURLProtocol.requestCount, 1, "a 403 is final; retrying it would only repeat the answer")
        XCTAssertTrue(permissions.permissions.isEmpty)
        XCTAssertFalse(permissions.isAdmin, "the capability set must change when the server says so")
        XCTAssertNil(permissions.refreshFailure, "a 403 is an answer, not a failed refresh")
    }

    func testAnswerReplacesPermissionsWithTheServersNewSet() async {
        holdAdminPermissions()
        AuthMeStubURLProtocol.reset([.profile(permissions: ["calls:answer"])])

        guard case .loaded(let response) = await loader.refresh() else { return XCTFail("200 loads") }

        XCTAssertEqual(response.roles, ["custom-role"], "role ids are returned as data, never interpreted")
        XCTAssertEqual(permissions.permissions, ["calls:answer"])
        XCTAssertFalse(permissions.isAdmin)
    }

    // MARK: - Cancellation

    func testCancelStopsRetryingAndLeavesPermissionsAlone() async {
        holdAdminPermissions()
        AuthMeStubURLProtocol.reset([.status(503)])

        let refresh = Task { await loader.refresh() }
        await waitUntil("first failure") { AuthMeStubURLProtocol.requestCount >= 1 }
        loader.cancel()

        guard case .cancelled = await refresh.value else { return XCTFail("cancel settles the refresh") }
        let settled = AuthMeStubURLProtocol.requestCount
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(AuthMeStubURLProtocol.requestCount, settled, "no request after cancel")
        XCTAssertTrue(permissions.isAdmin)
    }

    func testLogoutClearDropsPermissionsAndTheFailure() {
        holdAdminPermissions()
        permissions.recordRefreshFailure()
        permissions.clear()

        XCTAssertTrue(permissions.permissions.isEmpty)
        XCTAssertNil(permissions.refreshFailure)
        permissions.recordRefreshFailure()
        XCTAssertEqual(permissions.refreshFailure, .noneKnown, "a cleared service has no answer to keep")
    }
}
