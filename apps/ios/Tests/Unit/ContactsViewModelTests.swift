import Foundation
import XCTest
@testable import Llamenos

/// A server that mounts only what `apps/worker/app.ts` mounts for contacts:
/// `GET /api/contacts` (paginated summaries) and `GET /api/contacts/:hash`
/// (`{notes, conversations}`), each also under `/api/hubs/:hubId`. Anything
/// else answers 404, exactly as the real router does, and is recorded.
private final class ContactsStubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var responses: [String: String] = [:]
    private static var seen: [String] = []

    /// Keys are `"METHOD /path"` or `"METHOD /path?query"`; the query form wins.
    static func reset(responses: [String: String]) {
        lock.lock()
        defer { lock.unlock() }
        self.responses = responses
        seen = []
    }

    /// Every request the client made, as `"METHOD /path?query"`.
    static func requests() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "contacts.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let query = request.url?.query.map { "?\($0)" } ?? ""
        Self.lock.lock()
        Self.seen.append("\(method) \(path)\(query)")
        let body = Self.responses["\(method) \(path)\(query)"] ?? Self.responses["\(method) \(path)"]
        Self.lock.unlock()

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

@MainActor
final class ContactsViewModelTests: XCTestCase {
    private let hubId = "hub-contacts-001"

    private func makeAPI(responses: [String: String]) throws -> APIService {
        ContactsStubURLProtocol.reset(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ContactsStubURLProtocol.self]
        let hubContext = HubContext()
        hubContext.setActiveHub(hubId)
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: "activeHubId") }
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: hubContext,
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://contacts.test")
        return api
    }

    private func summaryJSON(_ hash: String, last4: String?, notes: Int = 0, conversations: Int = 0) -> String {
        let last4Field = last4.map { #""last4":"\#($0)","# } ?? ""
        return #"""
        {"contactHash":"\#(hash)",\#(last4Field)"firstSeen":"2026-01-01T00:00:00.000Z","lastSeen":"2026-02-01T00:00:00.000Z","callCount":4,"conversationCount":\#(conversations),"noteCount":\#(notes),"reportCount":1}
        """#
    }

    private func summary(_ hash: String, last4: String?, notes: Int = 0, conversations: Int = 0) throws -> SharedContactTimelineListResponseContact {
        try JSONDecoder().decode(
            SharedContactTimelineListResponseContact.self,
            from: Data(summaryJSON(hash, last4: last4, notes: notes, conversations: conversations).utf8)
        )
    }

    // MARK: - Search

    /// There is no contact search route. The search must find a contact whose
    /// row is on the SECOND page of the list, call only the list route, and not
    /// list a conversation-only contact twice though the server repeats it on
    /// every page.
    func testSearchReadsEveryPageOfTheListAndNeverCallsASearchRoute() async throws {
        let conversationOnly = summaryJSON("cccc0000", last4: "7777", conversations: 2)
        let page1 = #"{"contacts":[\#(summaryJSON("aaaa1111", last4: "1111", notes: 1)),\#(conversationOnly)],"total":3}"#
        let page2 = #"{"contacts":[\#(summaryJSON("bbbb2222", last4: "4242", notes: 1)),\#(conversationOnly)],"total":3}"#
        let api = try makeAPI(responses: [
            "GET /api/hubs/\(hubId)/contacts?page=1&limit=200": page1,
            "GET /api/hubs/\(hubId)/contacts?page=2&limit=200": page2,
        ])
        let viewModel = ContactsViewModel(apiService: api)
        viewModel.searchQuery = "***4242"

        await viewModel.search()

        XCTAssertNil(viewModel.errorMessage, "Search over a mounted list route must not fail")
        XCTAssertEqual(viewModel.contacts.map(\.contactHash), ["bbbb2222"],
                       "A contact on page 2 is found by the digits the row displays")
        XCTAssertEqual(viewModel.total, 1)
        XCTAssertEqual(
            ContactsStubURLProtocol.requests(),
            [
                "GET /api/hubs/\(hubId)/contacts?page=1&limit=200",
                "GET /api/hubs/\(hubId)/contacts?page=2&limit=200",
            ],
            "Search must read the mounted list route page by page and nothing else — " +
                "`/contacts/search` is shadowed by `/contacts/:hash` and answers 200 for a contact named \"search\""
        )
    }

    func testSearchWithNoMatchEmptiesTheListRatherThanKeepingStaleRows() async throws {
        let page = #"{"contacts":[\#(summaryJSON("aaaa1111", last4: "1111"))],"total":1}"#
        let api = try makeAPI(responses: ["GET /api/hubs/\(hubId)/contacts?page=1&limit=200": page])
        let viewModel = ContactsViewModel(apiService: api)
        viewModel.contacts = [try summary("stale0000", last4: "0000")]
        viewModel.searchQuery = "9999"

        await viewModel.search()

        XCTAssertTrue(viewModel.contacts.isEmpty, "A search that matches nothing shows nothing")
        XCTAssertEqual(viewModel.total, 0)
    }

    func testSearchSurfacesAFailedListRequest() async throws {
        let api = try makeAPI(responses: [:])
        let viewModel = ContactsViewModel(apiService: api)
        viewModel.searchQuery = "1111"

        await viewModel.search()

        XCTAssertNotNil(viewModel.errorMessage, "An unreachable list must be reported, not shown as 'no results'")
    }

    func testSummaryMatchesLastFourAndHashPrefixAndIgnoresMask() throws {
        let row = try summary("deadbeef99", last4: "5150")
        XCTAssertTrue(row.matches("5150"))
        XCTAssertTrue(row.matches("***5150"), "The displayed form finds the same contact")
        XCTAssertTrue(row.matches("DEADBEEF"), "Hash match is case-insensitive")
        XCTAssertTrue(row.matches("  "), "An empty query matches everything")
        XCTAssertFalse(row.matches("0000"))
    }

    // MARK: - Detail

    /// `GET /api/contacts/:hash` answers `{notes, conversations}`. The profile
    /// is the list row plus that activity — the old decode asked for a
    /// `contact` key the server never sends and so always failed.
    func testDetailLoadsTheMountedActivityRouteAndCountsItsRows() async throws {
        let hash = "aaaa1111"
        let activity = #"{"notes":[{"id":"n1"},{"id":"n2"},{"id":"n3"}],"conversations":[{"id":"c1"}]}"#
        let api = try makeAPI(responses: ["GET /api/hubs/\(hubId)/contacts/\(hash)": activity])
        let row = try summary(hash, last4: "1111", notes: 99, conversations: 99)
        let viewModel = ContactDetailViewModel(apiService: api, summary: row)

        await viewModel.loadContact()

        XCTAssertNil(viewModel.errorMessage, "The activity route is mounted; loading the profile must succeed")
        let contact = try XCTUnwrap(viewModel.contact, "The profile is built once the activity arrives")
        XCTAssertEqual(contact.noteCount, 3, "Counts come from what the server returned, not the stale row")
        XCTAssertEqual(contact.conversationCount, 1)
        XCTAssertEqual(contact.callCount, 4, "Calls and reports are not in the activity response; the row's counts stand")
        XCTAssertEqual(contact.reportCount, 1)
        XCTAssertEqual(contact.last4, "1111")
        XCTAssertNil(contact.contactType, "The server holds no contact type for a hashed contact; none is invented")
        XCTAssertEqual(ContactsStubURLProtocol.requests(), ["GET /api/hubs/\(hubId)/contacts/\(hash)"])
    }

    func testDetailReportsAnUnmountedRouteInsteadOfRenderingAnEmptyProfile() async throws {
        let api = try makeAPI(responses: [:])
        let viewModel = ContactDetailViewModel(apiService: api, summary: try summary("aaaa1111", last4: nil))

        await viewModel.loadContact()

        XCTAssertNil(viewModel.contact, "No response, no profile")
        XCTAssertNotNil(viewModel.errorMessage, "The failure is shown, not swallowed")
    }
}
