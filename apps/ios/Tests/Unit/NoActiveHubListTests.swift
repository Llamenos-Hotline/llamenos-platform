import Foundation
import XCTest
@testable import Llamenos

/// Records every request and answers 404, like a server with nothing mounted at the path.
private final class RecordingStubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var seen: [String] = []

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        seen = []
    }

    /// Every request the client made, as `"METHOD /path"`.
    static func requests() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "no-active-hub.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.seen.append("\(request.httpMethod ?? "GET") \(request.url?.path ?? "")")
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 404,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"Not Found"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// No request may name a hub-owned resource outside `/api/hubs/:hubId`.
private func assertNoUnscopedHubOwnedRequest(file: StaticString = #filePath, line: UInt = #line) {
    let unscoped = RecordingStubURLProtocol.requests().filter { request in
        [
            "/api/reports", "/api/notes", "/api/contacts", "/api/audit",
            // #2461: the server wrote these into hub "" and read any hub's row by id.
            "/api/records", "/api/events", "/api/evidence", "/api/calls", "/api/shifts", "/api/ring-groups",
        ].contains { prefix in
            request.hasSuffix(" \(prefix)") || request.contains(" \(prefix)/")
        }
    }
    XCTAssertEqual(unscoped, [], "A hub-owned list has no unscoped route to ask", file: file, line: line)
}

/// A hub-owned list with no active hub (#2405, #2461).
///
/// Notes, reports, contacts and the audit log have no unscoped route (#2395), nor have
/// records, events, evidence, calls, shifts and ring groups (#2461), so with no
/// hub active there is nothing to browse. The screen must settle on its empty state —
/// not on an error, and not by asking the server for the bare path. The hub URL IS
/// configured here, so the reason is the missing active hub and not `.noBaseURL`.
@MainActor
final class NoActiveHubListTests: XCTestCase {

    private func makeAPI() throws -> APIService {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        RecordingStubURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingStubURLProtocol.self]
        let hubContext = HubContext()
        XCTAssertNil(hubContext.activeHubId, "precondition: no hub is active")
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: hubContext,
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://no-active-hub.test")
        return api
    }


    func testNoHubIsAnAPIErrorThatMeansNothingToBrowse() {
        XCTAssertTrue(APIError.isNoHub(APIError.noActiveHub))
        XCTAssertTrue(APIError.isNoHub(APIError.noBaseURL))
        XCTAssertFalse(APIError.isNoHub(APIError.requestFailed(statusCode: 403, body: "")))
        XCTAssertFalse(APIError.isNoHub(URLError(.notConnectedToInternet)))
    }

    func testReportsSettleEmptyWithoutAnError() async throws {
        let viewModel = ReportsViewModel(apiService: try makeAPI(), cryptoService: CryptoService())

        await viewModel.loadReports()

        XCTAssertNil(viewModel.errorMessage, "No hub is nothing to load, not a failure — ReportsView renders reports-error otherwise")
        XCTAssertTrue(viewModel.reports.isEmpty)
        XCTAssertFalse(viewModel.isLoading)
        assertNoUnscopedHubOwnedRequest()
    }

    func testNotesSettleEmptyWithoutAnError() async throws {
        let viewModel = NotesViewModel(apiService: try makeAPI(), cryptoService: CryptoService())

        await viewModel.loadNotes()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.notes.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    func testContactsSettleEmptyWithoutAnError() async throws {
        let viewModel = ContactsViewModel(apiService: try makeAPI())

        await viewModel.loadContacts()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.contacts.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    func testTriageSettlesEmptyWithoutAnError() async throws {
        let viewModel = TriageViewModel(apiService: try makeAPI(), cryptoService: CryptoService())

        await viewModel.loadReports()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.reports.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    func testRecordsSettleEmptyWithoutAnError() async throws {
        let viewModel = CaseManagementViewModel(apiService: try makeAPI(), cryptoService: CryptoService())

        await viewModel.loadRecords()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.recordsLoadError)
        XCTAssertTrue(viewModel.records.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    func testRingGroupsSettleEmptyWithoutAnError() async throws {
        let viewModel = ShiftAdminViewModel(apiService: try makeAPI(), hubContext: HubContext())

        await viewModel.loadRingGroups()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.ringGroups.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    /// A write is different: it had somewhere it needed to go, so it reports why it failed.
    func testClosingAReportWithNoHubSaysNoHubIsSelected() async throws {
        let viewModel = ReportsViewModel(apiService: try makeAPI(), cryptoService: CryptoService())

        await viewModel.closeReport(id: "report-1")

        XCTAssertEqual(viewModel.errorMessage, APIError.noActiveHub.errorDescription)
        assertNoUnscopedHubOwnedRequest()
    }
}

/// Answers hub A's ring groups, fallback group and join requests; 404 for anything else.
private final class HubAStubURLProtocol: URLProtocol {
    static let host = "hub-a-rows.test"

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == host
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let body: String?
        switch path {
        case "/api/hubs/hub-A/ring-groups":
            body = #"{"ringGroups":[{"id":"rg-a","hubId":"hub-A","encryptedName":"Northside night crew","memberCount":3,"createdAt":"2026-11-01T00:00:00.000Z"}]}"#
        case "/api/hubs/hub-A/shifts/fallback":
            body = #"{"userPubkeys":["pk-hub-a-fallback"]}"#
        case "/api/hubs/hub-A/shifts/requests":
            body = #"{"requests":[{"id":"req-a","hubId":"hub-A","shiftId":"shift-a","userPubkey":"pk-a","type":"join","status":"pending","reviewedBy":null,"reviewedAt":null,"createdAt":"2026-11-01T00:00:00.000Z"}]}"#
        default:
            body = nil
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: body == nil ? 404 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? #"{"error":"Not Found"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A screen already holding hub A's rows when the active hub is cleared (#2478).
///
/// The reload has no hub to ask, so it sends nothing — and the rows it was showing are
/// another hub's. They must go, not stay on screen outside any hub.
@MainActor
final class HubOwnedRowsClearTests: XCTestCase {

    private func makeViewModel() throws -> (ShiftAdminViewModel, HubContext) {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HubAStubURLProtocol.self]
        let hubContext = HubContext()
        hubContext.setActiveHub("hub-A")
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: hubContext,
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://\(HubAStubURLProtocol.host)")
        return (ShiftAdminViewModel(apiService: api, hubContext: hubContext), hubContext)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    func testRingGroupsOfHubAAreGoneOnceTheHubIsCleared() async throws {
        let (viewModel, hubContext) = try makeViewModel()
        await viewModel.loadRingGroups()
        XCTAssertEqual(viewModel.ringGroups.map(\.id), ["rg-a"], "precondition: hub A's ring groups are on screen")

        hubContext.clearActiveHub()
        await viewModel.loadRingGroups()

        XCTAssertEqual(viewModel.ringGroups.map(\.id), [], "hub A's ring groups stayed on screen with no hub")
        XCTAssertNil(viewModel.errorMessage)
    }

    func testFallbackGroupOfHubAIsGoneOnceTheHubIsCleared() async throws {
        let (viewModel, hubContext) = try makeViewModel()
        await viewModel.loadFallback()
        XCTAssertEqual(viewModel.fallbackPubkeys, ["pk-hub-a-fallback"], "precondition")

        hubContext.clearActiveHub()
        await viewModel.loadFallback()

        XCTAssertEqual(viewModel.fallbackPubkeys, [], "hub A's fallback group stayed on screen with no hub")
        XCTAssertNil(viewModel.errorMessage)
    }

    func testJoinRequestsOfHubAAreGoneOnceTheHubIsCleared() async throws {
        let (viewModel, hubContext) = try makeViewModel()
        await viewModel.loadRequests()
        XCTAssertEqual(viewModel.requests.map(\.id), ["req-a"], "precondition")

        hubContext.clearActiveHub()
        await viewModel.loadRequests()

        XCTAssertEqual(viewModel.requests.map(\.id), [], "hub A's join requests stayed on screen with no hub")
        XCTAssertNil(viewModel.errorMessage)
    }
}

/// No active hub because the hub could not be ASKED which hubs this user belongs to (#2478).
///
/// The session's hub-list fetch failed, so a nil active hub is not "a member of no hub" —
/// the hub is unreachable. A hub-owned screen must say so. The ios-e2e shard caught the
/// Shifts tab settling on an empty schedule, the same as a hub with nothing in it, for a
/// hub that refused the connection. Nothing may be sent to an unscoped path either way.
@MainActor
final class MembershipUnavailableListTests: XCTestCase {

    private let unreachable = APIError.networkError(URLError(.cannotConnectToHost))

    private func makeAPI(membershipFailure: (any Error)?) throws -> (APIService, HubContext) {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        RecordingStubURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingStubURLProtocol.self]
        let hubContext = HubContext()
        XCTAssertNil(hubContext.activeHubId, "precondition: no hub is active")
        hubContext.recordMembershipLoad(failure: membershipFailure)
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: hubContext,
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://no-active-hub.test")
        return (api, hubContext)
    }

    private func makeShifts(_ api: APIService, _ hubContext: HubContext) -> ShiftsViewModel {
        ShiftsViewModel(
            apiService: api,
            hubContext: hubContext,
            linphoneService: MockLinphoneService(),
            shiftClockService: ShiftClockService(apiService: api)
        )
    }

    func testShiftsReportAnUnreachableHubInsteadOfAnEmptySchedule() async throws {
        let (api, hubContext) = try makeAPI(membershipFailure: unreachable)
        let viewModel = makeShifts(api, hubContext)

        await viewModel.loadShifts()

        XCTAssertEqual(
            viewModel.errorMessage, unreachable.errorDescription,
            "The hub could not be reached — ShiftsView renders shifts-error from this"
        )
        XCTAssertTrue(viewModel.shifts.isEmpty, "No schedule could be loaded")
        assertNoUnscopedHubOwnedRequest()
    }

    func testNotesReportAnUnreachableHubInsteadOfAnEmptyList() async throws {
        let (api, _) = try makeAPI(membershipFailure: unreachable)
        let viewModel = NotesViewModel(apiService: api, cryptoService: CryptoService())

        await viewModel.loadNotes()

        XCTAssertEqual(viewModel.errorMessage, unreachable.errorDescription)
        XCTAssertTrue(viewModel.notes.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    /// The hub list WAS fetched and names no hub: that is membership of none, and the
    /// schedule is simply empty.
    func testShiftsOfAMemberOfNoHubAreEmptyWithoutAnError() async throws {
        let (api, hubContext) = try makeAPI(membershipFailure: nil)
        let viewModel = makeShifts(api, hubContext)

        await viewModel.loadShifts()

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.shifts.isEmpty)
        assertNoUnscopedHubOwnedRequest()
    }

    /// A screen keyed on the active hub alone never reloads when the hub list fails after
    /// it loaded: the active hub is nil before and after. `browsing` changes.
    func testAFailedMembershipLoadChangesWhatScreensReloadOn() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        let hubContext = HubContext()
        let before = hubContext.browsing

        hubContext.recordMembershipLoad(failure: unreachable)

        XCTAssertNil(hubContext.activeHubId)
        XCTAssertNotEqual(hubContext.browsing, before)
    }
}
