import Foundation
import XCTest
@testable import Llamenos

// MARK: - MembershipStubURLProtocol

/// Serves canned responses keyed by request path, recording every request.
/// Registered per-session (protocolClasses), never globally, so no other suite's
/// traffic can reach it.
private final class MembershipStubURLProtocol: URLProtocol {
    static var responses: [String: String] = [:]
    static var requestedPaths: [String] = []
    private static let lock = NSLock()

    static func reset(_ responses: [String: String]) {
        lock.lock(); defer { lock.unlock() }
        self.responses = responses
        requestedPaths = []
    }

    static func paths() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return requestedPaths
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.lock()
        Self.requestedPaths.append("\(request.httpMethod ?? "GET") \(path)")
        let body = Self.responses[path]
        Self.lock.unlock()

        let status = body == nil ? 404 : 200
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? #"{"error":"Not Found"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - RecordingHubCrypto

/// Crypto mock recording which hub IDs had loadHubKey called.
/// NSLock because eager key loading runs in concurrent task-group children.
private final class RecordingHubCrypto: HubCryptoServiceProtocol, @unchecked Sendable {
    private let lock = NSLock()
    var cachedHubIds: Set<String> = []
    private var _loadedHubIds: [String] = []
    var loadedHubIds: [String] { lock.withLock { _loadedHubIds } }

    func hasHubKey(hubId: String) -> Bool {
        lock.withLock { cachedHubIds.contains(hubId) }
    }

    func loadHubKey(hubId: String, envelope: HubKeyEnvelopeResponse) throws {
        lock.withLock { _loadedHubIds.append(hubId) }
    }
}

// MARK: - FailingHubListAPI

/// API mock whose hub-list request always fails.
private final class FailingHubListAPI: HubAPIServiceProtocol {
    func getHubKey(_ hubId: String) async throws -> HubKeyEnvelopeResponse {
        throw URLError(.badServerResponse)
    }
    func hp(_ path: String) -> String { path }
    func request<T: Decodable>(method: String, path: String, body: (any Encodable)?) async throws -> T {
        throw URLError(.cannotConnectToHost)
    }
}

// MARK: - Helpers

private func makeMemberHub(id: String) -> SharedHub {
    SharedHub(
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "pub001",
        description: nil,
        id: id,
        name: "Hub \(id)",
        phoneNumber: nil,
        slug: "hub-\(id)",
        status: .active,
        updatedAt: "2026-01-01T00:00:00Z"
    )
}

/// Hub-list JSON the real APIService decodes into HubsListResponse.
private func hubListJSON(_ ids: [String]) -> String {
    let hubs = ids.map { id in
        #"{"createdAt":"2026-01-01T00:00:00Z","createdBy":"pub001","description":null,"id":"\#(id)","name":"Hub \#(id)","phoneNumber":null,"slug":"hub-\#(id)","status":"active","updatedAt":"2026-01-01T00:00:00Z"}"#
    }.joined(separator: ",")
    return #"{"hubs":[\#(hubs)]}"#
}

// MARK: - HubMembershipServiceTests

/// #1720: the session — not a settings screen — must load the user's hubs.
///
/// Until this issue the ONLY `GET /api/hubs` call site was
/// `HubManagementViewModel.loadHubs` (Settings → Hubs), so a user who never
/// opened it had no active hub and no hub keys. These tests pin two halves:
///
///   - behaviour: `HubMembershipService.loadMembership` fetches the list over
///     the real APIService request path, reconciles the active hub against
///     membership (mirroring Android's HubRepository.loadInitialHub, #1340),
///     and eager-loads hub keys;
///   - wiring: `AppState.didUnlock` / `didCompleteOnboarding` schedule the load
///     (via the DEBUG `loadMemberHubsHandlerForTesting` seam).
///
/// Each fails with the loader removed: the behaviour tests get no requests, the
/// wiring tests get no seam call.
@MainActor
final class HubMembershipServiceTests: XCTestCase {

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    private func makeStubbedAPI() throws -> APIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MembershipStubURLProtocol.self]
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: HubContext(),
            sessionConfiguration: config
        )
        try api.configure(hubURLString: "https://hub-membership.test")
        return api
    }

    // MARK: - Behaviour (scenario-named)

    /// Scenario: "Hub keys load for every member hub when the session starts".
    /// Drives the REAL APIService request path against the stub: with the loader
    /// call removed, no request is ever made and nothing is decrypted.
    func testHubKeysLoadForEveryMemberHubWhenTheSessionStarts() async throws {
        let api = try makeStubbedAPI()
        MembershipStubURLProtocol.reset([
            "/api/hubs": hubListJSON(["hub-001", "hub-002", "hub-003"]),
            "/api/hubs/hub-001/key": #"{"envelope":{"ct":"11","enc":"22","pubkey":"33"}}"#,
            "/api/hubs/hub-002/key": #"{"envelope":{"ct":"11","enc":"22","pubkey":"33"}}"#,
            "/api/hubs/hub-003/key": #"{"envelope":{"ct":"11","enc":"22","pubkey":"33"}}"#,
        ])

        let ctx = HubContext()
        let crypto = RecordingHubCrypto()
        let service = HubMembershipService(apiService: api, cryptoService: crypto, hubContext: ctx)

        let loaded = await service.loadMembership()

        XCTAssertTrue(loaded, "Membership load should succeed against a 200 hub list")
        XCTAssertEqual(service.memberHubs.map(\.id), ["hub-001", "hub-002", "hub-003"])
        XCTAssertTrue(service.hasLoaded)
        XCTAssertEqual(ctx.activeHubId, "hub-001", "No persisted choice → first member hub becomes active")
        XCTAssertTrue(
            MembershipStubURLProtocol.paths().contains("GET /api/hubs"),
            "The membership load must GET /api/hubs. Requests: \(MembershipStubURLProtocol.paths())"
        )
        XCTAssertEqual(
            Set(crypto.loadedHubIds), ["hub-001", "hub-002", "hub-003"],
            "Every member hub's key must be loaded — an unloaded hub is unreadable"
        )
    }

    /// Scenario: "A stale active hub is replaced on session restore".
    /// The persisted hub the user is no longer a member of must not survive —
    /// that is the #1708 failure shape (hub-scoped requests 403 against a
    /// foreign hub).
    func testAStaleActiveHubIsReplacedOnSessionRestore() async throws {
        let api = try makeStubbedAPI()
        MembershipStubURLProtocol.reset([
            "/api/hubs": hubListJSON(["hub-A", "hub-B"]),
        ])

        let ctx = HubContext()
        ctx.setActiveHub("hub-departed")
        let service = HubMembershipService(
            apiService: api, cryptoService: RecordingHubCrypto(), hubContext: ctx
        )

        let loaded = await service.loadMembership()

        XCTAssertTrue(loaded)
        XCTAssertEqual(
            ctx.activeHubId, "hub-A",
            "A persisted hub that is no longer a membership must be replaced with a current one"
        )
    }

    // MARK: - Behaviour (supporting)

    /// A persisted hub the user still belongs to is the user's choice — the
    /// session load must never hijack browsing context.
    func testMembershipLoadKeepsPersistedHubThatIsStillAMembership() async throws {
        let api = try makeStubbedAPI()
        MembershipStubURLProtocol.reset([
            "/api/hubs": hubListJSON(["hub-A", "hub-B"]),
        ])

        let ctx = HubContext()
        ctx.setActiveHub("hub-B")
        let service = HubMembershipService(
            apiService: api, cryptoService: RecordingHubCrypto(), hubContext: ctx
        )

        let loaded = await service.loadMembership()

        XCTAssertTrue(loaded)
        XCTAssertEqual(ctx.activeHubId, "hub-B")
    }

    /// A user who belongs to no hub has no active hub — keeping the stale one
    /// would aim every hub-scoped request at a hub they cannot use.
    func testMembershipLoadClearsActiveHubWhenMembershipIsEmpty() async throws {
        let api = try makeStubbedAPI()
        MembershipStubURLProtocol.reset([
            "/api/hubs": #"{"hubs":[]}"#,
        ])

        let ctx = HubContext()
        ctx.setActiveHub("hub-departed")
        let service = HubMembershipService(
            apiService: api, cryptoService: RecordingHubCrypto(), hubContext: ctx
        )

        let loaded = await service.loadMembership()

        XCTAssertTrue(loaded)
        XCTAssertNil(ctx.activeHubId)
        XCTAssertTrue(service.memberHubs.isEmpty)
    }

    /// A failed load (offline at unlock, server down) must leave the persisted
    /// active hub and the previous snapshot untouched — the next unlock retries.
    func testMembershipLoadFailureLeavesSessionStateUntouched() async {
        let ctx = HubContext()
        ctx.setActiveHub("hub-kept")
        let service = HubMembershipService(
            apiService: FailingHubListAPI(), cryptoService: RecordingHubCrypto(), hubContext: ctx
        )

        let loaded = await service.loadMembership()

        XCTAssertFalse(loaded)
        XCTAssertEqual(ctx.activeHubId, "hub-kept")
        XCTAssertFalse(service.hasLoaded)
        XCTAssertTrue(service.memberHubs.isEmpty)
    }

    /// Logout resets the snapshot so a stale list cannot leak into the next session.
    func testResetClearsMembershipSnapshot() async throws {
        let api = try makeStubbedAPI()
        MembershipStubURLProtocol.reset([
            "/api/hubs": hubListJSON(["hub-A"]),
        ])
        let service = HubMembershipService(
            apiService: api, cryptoService: RecordingHubCrypto(), hubContext: HubContext()
        )

        XCTAssertTrue(await service.loadMembership())
        XCTAssertTrue(service.hasLoaded)

        service.reset()

        XCTAssertFalse(service.hasLoaded)
        XCTAssertTrue(service.memberHubs.isEmpty)
    }

    // MARK: - Wiring (scenario-named)

    /// Scenario: "Unlocking the app loads member hubs". Fails when the
    /// `loadMemberHubs()` call is removed from `didUnlock`.
    func testUnlockingTheAppLoadsMemberHubs() {
        let appState = AppState(hubContext: HubContext())
        var fired = false
        appState.loadMemberHubsHandlerForTesting = { fired = true }

        appState.didUnlock()

        XCTAssertTrue(fired, "didUnlock must schedule the membership load (#1720)")
        XCTAssertEqual(appState.authStatus, .unlocked)
    }

    /// Scenario: "Completing onboarding loads member hubs". Fails when the
    /// `loadMemberHubs()` call is removed from `didCompleteOnboarding`.
    func testCompletingOnboardingLoadsMemberHubs() {
        let appState = AppState(hubContext: HubContext())
        var fired = false
        appState.loadMemberHubsHandlerForTesting = { fired = true }

        appState.didCompleteOnboarding()

        XCTAssertTrue(fired, "didCompleteOnboarding must schedule the membership load (#1720)")
        XCTAssertEqual(appState.authStatus, .unlocked)
    }
}
