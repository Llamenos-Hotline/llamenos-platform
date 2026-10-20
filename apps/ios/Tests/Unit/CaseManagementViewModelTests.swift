import Foundation
import XCTest
@testable import Llamenos

// MARK: - CaseListStubURLProtocol

/// Serves canned Cases-API responses, each after its own delay, so a test can choose
/// the ORDER in which the case-management, entity-types and records requests answer.
///
/// A route holds a queue of responses consumed one per request in arrival order; the
/// last one repeats. That makes "the first call is slow, every later call is fast"
/// deterministic without depending on which task the scheduler starts first.
private final class CaseListStubURLProtocol: URLProtocol {
    struct Response {
        var status = 200
        var body: String
        var delay: TimeInterval = 0
    }

    private static let lock = NSLock()
    private static var routes: [String: [Response]] = [:]
    private static var arrivals: [String: Int] = [:]
    private static var onFirstArrival: ((String) -> Void)?

    /// `routes` is keyed by the END of the request path, so the tests do not depend
    /// on whether a hub is active (the API prefixes `/hubs/<id>` when one is).
    static func reset(_ routes: [String: [Response]], onFirstArrival: ((String) -> Void)? = nil) {
        lock.lock()
        defer { lock.unlock() }
        self.routes = routes
        arrivals = [:]
        self.onFirstArrival = onFirstArrival
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "case-list.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private var stopped = false
    private let stoppedLock = NSLock()

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.lock()
        let suffix = Self.routes.keys.first { path.hasSuffix($0) }
        var response = Response(status: 404, body: #"{"error":"Not Found"}"#)
        var notify: ((String) -> Void)?
        if let suffix, let queue = Self.routes[suffix], !queue.isEmpty {
            let seen = Self.arrivals[suffix, default: 0]
            response = queue[min(seen, queue.count - 1)]
            Self.arrivals[suffix] = seen + 1
            if seen == 0 { notify = Self.onFirstArrival }
        }
        Self.lock.unlock()
        notify?(suffix ?? path)

        DispatchQueue.global().asyncAfter(deadline: .now() + response.delay) { [self] in
            stoppedLock.lock()
            let alreadyStopped = stopped
            stoppedLock.unlock()
            guard !alreadyStopped, let url = request.url else { return }
            let http = HTTPURLResponse(
                url: url,
                statusCode: response.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(response.body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        stoppedLock.lock()
        stopped = true
        stoppedLock.unlock()
    }
}

// MARK: - Route names

/// File-level so the stub's callback (which the URL loading system calls off the main
/// actor) can name them without touching the main-actor test class.
private enum CaseListRoute {
    static let caseManagement = "/settings/cms/case-management"
    static let entityTypes = "/settings/cms/entity-types"
    static let records = "/records"
}

// MARK: - CaseManagementViewModelTests

/// What the Cases tab shows must be a function of what the hub answered, never of
/// which request answered first (#1893): `testCaseListEmptyState` ejected unrelated
/// PRs from the merge queue when the screen did not settle on the empty state.
@MainActor
final class CaseManagementViewModelTests: XCTestCase {
    private typealias Stub = CaseListStubURLProtocol

    private static let enabled = #"{"enabled":true}"#
    private static let disabled = #"{"enabled":false}"#
    private static let oneEntityType = """
    {"entityTypes":[{"id":"et-1","name":"case","label":"Case","labelPlural":"Cases","fields":[],\
    "statuses":[{"label":"Open","order":0,"value":"open"}],"defaultStatus":"open"}]}
    """
    private static let noEntityTypes = #"{"entityTypes":[]}"#
    private static let noRecords = #"{"records":[],"total":0}"#

    private func makeViewModel() throws -> CaseManagementViewModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Stub.self]
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: HubContext(),
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://case-list.test")
        return CaseManagementViewModel(apiService: api, cryptoService: CryptoService())
    }

    func testScreenIsLoadingBeforeAnythingHasAnswered() throws {
        let viewModel = try makeViewModel()

        XCTAssertEqual(viewModel.screen, .loading, "Nothing has been requested, so nothing can be shown yet")
    }

    func testEmptyHubShowsTheEmptyStateWhicheverRequestAnswersFirst() async throws {
        let orders: [(label: String, caseManagement: TimeInterval, entityTypes: TimeInterval)] = [
            ("case management answers first", 0, 0.3),
            ("entity types answer first", 0.3, 0),
            ("both answer together", 0.1, 0.1),
        ]
        for order in orders {
            Stub.reset([
                CaseListRoute.caseManagement: [.init(body: Self.enabled, delay: order.caseManagement)],
                CaseListRoute.entityTypes: [.init(body: Self.oneEntityType, delay: order.entityTypes)],
                CaseListRoute.records: [.init(body: Self.noRecords)],
            ])
            let viewModel = try makeViewModel()

            await viewModel.loadInitial()

            XCTAssertEqual(
                viewModel.screen, .empty(canCreate: true),
                "A hub with case management on, an entity type and no cases should settle on the empty state with New Case (\(order.label))"
            )
            XCTAssertTrue(viewModel.canCreateCase, "New Case and the empty state share one predicate (\(order.label))")
        }
    }

    func testHubWithoutEntityTypesAsksForATemplateInsteadOfOfferingNewCase() async throws {
        Stub.reset([
            CaseListRoute.caseManagement: [.init(body: Self.enabled)],
            CaseListRoute.entityTypes: [.init(body: Self.noEntityTypes)],
            CaseListRoute.records: [.init(body: Self.noRecords)],
        ])
        let viewModel = try makeViewModel()

        await viewModel.loadInitial()

        XCTAssertEqual(viewModel.screen, .empty(canCreate: false))
        XCTAssertFalse(viewModel.canCreateCase, "There is no entity type to create a case from")
    }

    func testHubWithCaseManagementOffShowsNotEnabled() async throws {
        Stub.reset([
            CaseListRoute.caseManagement: [.init(body: Self.disabled)],
            CaseListRoute.entityTypes: [.init(body: Self.oneEntityType)],
        ])
        let viewModel = try makeViewModel()

        await viewModel.loadInitial()

        XCTAssertEqual(viewModel.screen, .disabled)
    }

    func testFailedEntityTypesShowTheErrorNotAnEmptyHub() async throws {
        Stub.reset([
            CaseListRoute.caseManagement: [.init(body: Self.enabled)],
            CaseListRoute.entityTypes: [.init(status: 500, body: #"{"error":"boom"}"#)],
            CaseListRoute.records: [.init(body: Self.noRecords)],
        ])
        let viewModel = try makeViewModel()

        await viewModel.loadInitial()

        guard case .failed = viewModel.screen else {
            return XCTFail("A failed entity-types request must not render as an empty hub, got \(viewModel.screen)")
        }
    }

    func testFailedRecordsFetchShowsTheErrorNotNoCasesYet() async throws {
        Stub.reset([
            CaseListRoute.caseManagement: [.init(body: Self.enabled)],
            CaseListRoute.entityTypes: [.init(body: Self.oneEntityType)],
            CaseListRoute.records: [.init(status: 500, body: #"{"error":"boom"}"#)],
        ])
        let viewModel = try makeViewModel()

        await viewModel.loadInitial()

        guard case .failed = viewModel.screen else {
            return XCTFail("A failed records fetch must not render as \"No cases yet\", got \(viewModel.screen)")
        }
    }

    /// The hub changes while a load is in flight, `.task(id:)` starts another, and the
    /// first one's answer arrives AFTER the replacement has finished. Cancellation
    /// alone does not stop that write — a request that had already answered resumes
    /// without throwing — so the first load must be refused by being superseded.
    func testASupersededLoadCannotOverwriteItsReplacement() async throws {
        let staleReachedTheServer = expectation(description: "the stale load's request reached the server")
        staleReachedTheServer.assertForOverFulfill = false
        Stub.reset(
            [
                // First call: slow, and says the feature is OFF. Every later call: fast, ON.
                CaseListRoute.caseManagement: [
                    .init(body: Self.disabled, delay: 0.5),
                    .init(body: Self.enabled),
                ],
                CaseListRoute.entityTypes: [.init(body: Self.oneEntityType)],
                CaseListRoute.records: [.init(body: Self.noRecords)],
            ],
            onFirstArrival: { suffix in
                if suffix == CaseListRoute.caseManagement { staleReachedTheServer.fulfill() }
            }
        )
        let viewModel = try makeViewModel()

        let stale = Task { await viewModel.loadInitial() }
        await fulfillment(of: [staleReachedTheServer], timeout: 5)

        await viewModel.loadInitial()
        XCTAssertEqual(viewModel.screen, .empty(canCreate: true), "The replacement load should settle first")

        await stale.value

        XCTAssertEqual(
            viewModel.screen, .empty(canCreate: true),
            "A superseded load answering late must not replace the screen its replacement settled"
        )
    }
}
