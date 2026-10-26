import Foundation
import XCTest
@testable import Llamenos

// MARK: - NoteCallChoicesStubURLProtocol

private final class NoteCallChoicesStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responses: [String: (Int, String)] = [:]
    private static let lock = NSLock()

    static func reset(_ responses: [String: (Int, String)]) {
        lock.lock(); defer { lock.unlock() }
        self.responses = responses
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        Self.lock.lock()
        let canned = Self.responses[key]
        Self.lock.unlock()
        let (status, body) = canned ?? (404, #"{"error":"Not Found"}"#)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - NoteCallChoicesTests

/// The note editor's call picker offers the calls this user may reference — by permission,
/// never by role (#2247) — and never a free-text reference (#2125).
@MainActor
final class NoteCallChoicesTests: XCTestCase {

    private let hub = "hub-A"
    private let me = String(repeating: "cd", count: 32)
    private let other = String(repeating: "ab", count: 32)

    private func call(_ id: String, status: String, answeredBy: String? = nil, at: String) -> String {
        let by = answeredBy.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"\#(id)","startedAt":"\#(at)","status":"\#(status)","answeredBy":\#(by)}"#
    }

    private func makeViewModel(
        canReadActive: Bool,
        canReadHistory: Bool,
        known: [CallReference] = []
    ) throws -> NoteCallChoicesViewModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NoteCallChoicesStubURLProtocol.self]
        let api = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)
        try api.configure(hubURLString: "https://hub.example.org")
        NoteCallChoicesStubURLProtocol.reset([
            "GET /api/hubs/\(hub)/calls/active": (200, #"""
            {"calls":[\#(call("mine-active", status: "in-progress", answeredBy: me, at: "2026-10-26T10:00:00.000Z")),
                      \#(call("theirs-active", status: "in-progress", answeredBy: other, at: "2026-10-26T09:00:00.000Z"))]}
            """#),
            "GET /api/hubs/\(hub)/calls/history": (200, #"""
            {"calls":[\#(call("old-1", status: "completed", answeredBy: other, at: "2026-10-25T10:00:00.000Z"))],"total":1,"page":1,"limit":50}
            """#),
        ])
        return NoteCallChoicesViewModel(
            apiService: api, hubId: hub, myPubkey: me,
            canReadActive: canReadActive, canReadHistory: canReadHistory, known: known
        )
    }

    func testAVolunteerIsOfferedOnlyTheirOwnCallsAndTheOnesHeld() async throws {
        let held = CallReference(id: "ended-1", hubId: hub, startedAt: Date(), phase: .ended)
        let vm = try makeViewModel(canReadActive: true, canReadHistory: false, known: [held])
        await vm.load()

        XCTAssertEqual(vm.choices.map(\.id), ["ended-1", "mine-active"], "held calls first; someone else's call is not theirs to reference")
        XCTAssertNil(vm.errorMessage)
    }

    func testAHistoryReaderIsOfferedTheHubsCalls() async throws {
        let vm = try makeViewModel(canReadActive: true, canReadHistory: true)
        await vm.load()

        XCTAssertEqual(vm.choices.map(\.id), ["mine-active", "theirs-active", "old-1"], "newest first")
    }

    func testAHeldCallIsNotOfferedTwice() async throws {
        let held = CallReference(id: "mine-active", hubId: hub, startedAt: Date(), phase: .inProgress)
        let vm = try makeViewModel(canReadActive: true, canReadHistory: true, known: [held])
        await vm.load()

        XCTAssertEqual(vm.choices.filter { $0.id == "mine-active" }.count, 1)
        XCTAssertEqual(vm.choices.first?.phase, .inProgress, "the held reference wins")
    }

    func testWithoutPermissionNothingIsFetched() async throws {
        let vm = try makeViewModel(canReadActive: false, canReadHistory: false)
        await vm.load()

        XCTAssertTrue(vm.choices.isEmpty)
    }

    func testAFailedListingIsReportedNotShownAsNoCalls() async throws {
        let vm = try makeViewModel(canReadActive: true, canReadHistory: true)
        NoteCallChoicesStubURLProtocol.reset([
            "GET /api/hubs/\(hub)/calls/history": (403, #"{"error":"Forbidden"}"#),
        ])
        await vm.load()

        XCTAssertNotNil(vm.errorMessage)
    }
}
