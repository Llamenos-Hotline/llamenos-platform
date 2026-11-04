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

/// A hub-owned list with no active hub (#2405).
///
/// Notes, reports, contacts and the audit log have no unscoped route (#2395), so with no
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

    /// No request may name a hub-owned resource outside `/api/hubs/:hubId`.
    private func assertNoUnscopedHubOwnedRequest(file: StaticString = #filePath, line: UInt = #line) {
        let unscoped = RecordingStubURLProtocol.requests().filter { request in
            ["/api/reports", "/api/notes", "/api/contacts", "/api/audit"].contains { prefix in
                request.hasSuffix(" \(prefix)") || request.contains(" \(prefix)/")
            }
        }
        XCTAssertEqual(unscoped, [], "A hub-owned list has no unscoped route to ask", file: file, line: line)
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

    /// A write is different: it had somewhere it needed to go, so it reports why it failed.
    func testClosingAReportWithNoHubSaysNoHubIsSelected() async throws {
        let viewModel = ReportsViewModel(apiService: try makeAPI(), cryptoService: CryptoService())

        await viewModel.closeReport(id: "report-1")

        XCTAssertEqual(viewModel.errorMessage, APIError.noActiveHub.errorDescription)
        assertNoUnscopedHubOwnedRequest()
    }
}
