import Foundation
import XCTest
@testable import Llamenos

// MARK: - CaseListStubURLProtocol

/// Serves canned Cases-API responses, each held until the thing it must follow has happened,
/// so a test can choose the ORDER in which the case-management, entity-types and records
/// requests answer without a clock deciding it: a response either answers once another
/// route's response has been delivered, or stays held until the test releases it.
///
/// A route holds a queue of responses consumed one per request in arrival order; the
/// last one repeats. That makes "the first call is slow, every later call is fast"
/// deterministic without depending on which task the scheduler starts first.
private final class CaseListStubURLProtocol: URLProtocol {
    struct Response {
        var status = 200
        var body: String
        /// The route whose response must have been delivered before this one is.
        var answersAfter: String?
        /// Held back until the test calls `release(_:)` for this route.
        var held = false
    }

    private struct Pending {
        let route: String
        let response: Response
        let deliver: () -> Void
    }

    private static let lock = NSLock()
    private static var routes: [String: [Response]] = [:]
    private static var arrivals: [String: Int] = [:]
    private static var onFirstArrival: ((String) -> Void)?
    private static var pending: [Pending] = []
    private static var delivered: Set<String> = []
    private static var released: Set<String> = []

    /// `routes` is keyed by the END of the request path, so the tests do not depend
    /// on whether a hub is active (the API prefixes `/hubs/<id>` when one is).
    static func reset(_ routes: [String: [Response]], onFirstArrival: ((String) -> Void)? = nil) {
        lock.lock()
        defer { lock.unlock() }
        self.routes = routes
        arrivals = [:]
        pending = []
        delivered = []
        released = []
        self.onFirstArrival = onFirstArrival
    }

    /// How many requests reached `route` since the last `reset(_:)`. A test that
    /// asserts what the screen shows after a response must first know the request was
    /// made — a guard that returns before asking would otherwise pass it vacuously.
    static func arrivalCount(_ route: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return arrivals[route, default: 0]
    }

    /// Let the held response on `route` answer.
    static func release(_ route: String) {
        lock.lock()
        released.insert(route)
        lock.unlock()
        deliverWhatIsReady()
    }

    /// Deliver every pending response whose conditions now hold; delivering one can make
    /// the next ready, so this runs until nothing more is.
    private static func deliverWhatIsReady() {
        while true {
            lock.lock()
            let index = pending.firstIndex { entry in
                (entry.response.answersAfter.map { delivered.contains($0) } ?? true)
                    && (!entry.response.held || released.contains(entry.route))
            }
            guard let index else {
                lock.unlock()
                return
            }
            let entry = pending.remove(at: index)
            delivered.insert(entry.route)
            lock.unlock()
            entry.deliver()
        }
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

        let deliver = { [self] in
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
        Self.lock.lock()
        Self.pending.append(Pending(route: suffix ?? path, response: response, deliver: deliver))
        Self.lock.unlock()
        Self.deliverWhatIsReady()
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
    private static let oneEntityType = ProtocolFixtures.entityTypeListJSON([
        ProtocolFixtures.entityTypeJSON(id: "et-1", name: "case", category: "case"),
    ])
    private static let noEntityTypes = ProtocolFixtures.entityTypeListJSON([])
    private static let noRecords = ProtocolFixtures.emptyRecordList

    /// Records are hub-owned (#2461): with no active hub `loadRecords()` has nothing to
    /// ask and never sends the request. Every test here is about what the hub answered,
    /// so each one browses an explicit hub rather than whatever `activeHubId` an earlier
    /// test left in `UserDefaults` (which `HubContext.init` reads).
    private static let hubId = "hub-cases"

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    private func makeViewModel() throws -> CaseManagementViewModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Stub.self]
        let hubContext = HubContext()
        hubContext.setActiveHub(Self.hubId)
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: hubContext,
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
        let orders: [(label: String, caseManagement: String?, entityTypes: String?)] = [
            ("case management answers first", nil, CaseListRoute.caseManagement),
            ("entity types answer first", CaseListRoute.entityTypes, nil),
            ("both answer together", nil, nil),
        ]
        for order in orders {
            Stub.reset([
                CaseListRoute.caseManagement: [.init(body: Self.enabled, answersAfter: order.caseManagement)],
                CaseListRoute.entityTypes: [.init(body: Self.oneEntityType, answersAfter: order.entityTypes)],
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

        XCTAssertEqual(
            Stub.arrivalCount(CaseListRoute.records), 1,
            "The records fetch must have been made for its failure to be what the screen shows"
        )
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
                // First call: held until the replacement has settled, and says the feature is
                // OFF. Every later call: answers at once, ON.
                CaseListRoute.caseManagement: [
                    .init(body: Self.disabled, held: true),
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

        Stub.release(CaseListRoute.caseManagement)
        await stale.value

        XCTAssertEqual(
            viewModel.screen, .empty(canCreate: true),
            "A superseded load answering late must not replace the screen its replacement settled"
        )
    }
}
