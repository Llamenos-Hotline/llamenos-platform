import Foundation
import XCTest
@testable import Llamenos

// MARK: - RelayStubURLProtocol

/// Serves canned responses keyed by URL path, and records every request path.
/// Private to this file so it never shares static state with other suites' stubs.
private final class RelayStubURLProtocol: URLProtocol {
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

// MARK: - RelayMultiHubTests

/// Issue #1015: the relay must use the server-advertised endpoint (`/ws`, not `/relay`)
/// and deliver events from EVERY member hub, not only the active one.
@MainActor
final class RelayMultiHubTests: XCTestCase {

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    // MARK: - Relay endpoint resolution

    func testRelayURLUsesServerAdvertisedPath() {
        let url = WebSocketService.relayURL(
            hubBaseURL: URL(string: "https://hub.example.org")!,
            advertised: "/ws"
        )
        XCTAssertEqual(url?.absoluteString, "wss://hub.example.org/ws")
    }

    func testRelayURLKeepsHubPort() {
        let url = WebSocketService.relayURL(
            hubBaseURL: URL(string: "https://hub.example.org:8443")!,
            advertised: "/ws"
        )
        XCTAssertEqual(url?.absoluteString, "wss://hub.example.org:8443/ws")
    }

    func testRelayURLAcceptsAbsoluteAdvertisedEndpoint() {
        let url = WebSocketService.relayURL(
            hubBaseURL: URL(string: "https://hub.example.org")!,
            advertised: "wss://relay.example.org/ws"
        )
        XCTAssertEqual(url?.absoluteString, "wss://relay.example.org/ws")
    }

    func testRelayURLRejectsCleartextRemoteEndpoint() {
        XCTAssertNil(WebSocketService.relayURL(
            hubBaseURL: URL(string: "https://hub.example.org")!,
            advertised: "ws://relay.example.org/ws"
        ))
        XCTAssertNil(WebSocketService.relayURL(
            hubBaseURL: URL(string: "http://hub.example.org")!,
            advertised: "/ws"
        ))
    }

    func testRelayURLAllowsCleartextOnlyOnLoopback() {
        let url = WebSocketService.relayURL(
            hubBaseURL: URL(string: "http://localhost:3000")!,
            advertised: "/ws"
        )
        XCTAssertEqual(url?.absoluteString, "ws://localhost:3000/ws")
    }

    func testRelayURLIsNilWhenServerAdvertisesNoRelay() {
        let base = URL(string: "https://hub.example.org")!
        XCTAssertNil(WebSocketService.relayURL(hubBaseURL: base, advertised: nil))
        XCTAssertNil(WebSocketService.relayURL(hubBaseURL: base, advertised: "  "))
    }

    // MARK: - Hub-scoped API paths

    func testHubPathMatchesServerMount() {
        // Server mounts hub routes at /api/hubs/:hubId/... (apps/worker/app.ts).
        XCTAssertEqual(APIService.hubPath("hub-B", "/api/calls/active"), "/api/hubs/hub-B/calls/active")
        XCTAssertEqual(APIService.hubPath("hub-B", "/api/calls/c1/hangup"), "/api/hubs/hub-B/calls/c1/hangup")
    }

    func testHpScopesToActiveHub() {
        let ctx = HubContext()
        ctx.setActiveHub("hub-A")
        let api = APIService(cryptoService: CryptoService(), hubContext: ctx)
        XCTAssertEqual(api.hp("/api/notes"), "/api/hubs/hub-A/notes")
    }

    // MARK: - Member-hub subscriptions

    func testAuthenticationSubscribesEveryMemberHubExceptGlobal() throws {
        let ws = WebSocketService(cryptoService: CryptoService())
        var sent: [String] = []
        ws.outboundMessageObserver = { sent.append($0) }

        ws.subscribeToMemberHubs(kinds: [1000, 1001])
        XCTAssertTrue(sent.isEmpty, "Nothing may be sent before the auth handshake completes")

        ws.receiveServerMessageForTesting(#"{"type":"authenticated","hubs":["hub-A","hub-B","global"]}"#)

        XCTAssertEqual(ws.memberHubIds, ["hub-A", "hub-B"])
        XCTAssertEqual(try subscribedHubIds(sent), ["hub-A", "hub-B"])
    }

    func testSubscribeToMemberHubsAfterAuthenticationSubscribesImmediately() throws {
        let ws = WebSocketService(cryptoService: CryptoService())
        var sent: [String] = []
        ws.outboundMessageObserver = { sent.append($0) }

        ws.receiveServerMessageForTesting(#"{"type":"authenticated","hubs":["hub-A","hub-B"]}"#)
        XCTAssertTrue(sent.isEmpty)

        ws.subscribeToMemberHubs(kinds: [1000])
        XCTAssertEqual(try subscribedHubIds(sent), ["hub-A", "hub-B"])
    }

    func testReauthenticationFollowsCurrentMembership() throws {
        let ws = WebSocketService(cryptoService: CryptoService())
        var sent: [String] = []
        ws.outboundMessageObserver = { sent.append($0) }
        ws.subscribeToMemberHubs(kinds: [1000])

        ws.receiveServerMessageForTesting(#"{"type":"authenticated","hubs":["hub-A","hub-B"]}"#)
        sent.removeAll()

        // Reconnect after the user left hub B and joined hub C.
        ws.receiveServerMessageForTesting(#"{"type":"authenticated","hubs":["hub-A","hub-C"]}"#)
        XCTAssertEqual(try subscribedHubIds(sent), ["hub-A", "hub-C"])
    }

    // MARK: - Dashboard surfaces a ring from a non-active hub

    func testRingOnNonActiveHubSurfacesCallAndActionsTargetThatHub() async throws {
        let ctx = HubContext()
        ctx.setActiveHub("hub-A")

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RelayStubURLProtocol.self]
        let api = APIService(cryptoService: CryptoService(), hubContext: ctx, sessionConfiguration: config)
        try api.configure(hubURLString: "https://hub.example.org")

        RelayStubURLProtocol.reset([
            "/api/shifts/my-status": #"{"onShift":true,"activeCallCount":1}"#,
            "/api/hubs/hub-A/calls/active": #"{"calls":[]}"#,
            "/api/hubs/hub-B/calls/active":
                #"{"calls":[{"id":"call-b","startedAt":"2026-09-26T10:00:00.000Z","status":"ringing","callerLast4":"4321"}]}"#,
            "/api/hubs/hub-B/calls/call-b/hangup": #"{"ok":true}"#,
        ])

        let ws = WebSocketService(cryptoService: CryptoService())
        ws.receiveServerMessageForTesting(#"{"type":"authenticated","hubs":["hub-A","hub-B","global"]}"#)

        let vm = DashboardViewModel(apiService: api, cryptoService: CryptoService(), webSocketService: ws, hubContext: ctx)
        XCTAssertEqual(vm.callHubIds, ["hub-A", "hub-B"], "Calls are polled on every member hub, active hub first")

        vm.startEventListener()
        defer { vm.stopEventListener() }
        // Let the listener register its stream continuation before emitting.
        try await waitUntil { true }
        ws.emitAttributedEvent(hubId: "hub-B", eventType: .callRing)

        try await waitUntil { vm.currentCall != nil }
        XCTAssertEqual(vm.currentCall?.id, "call-b")
        XCTAssertEqual(vm.currentCall?.hubId, "hub-B")
        XCTAssertEqual(ctx.activeHubId, "hub-A", "A background ring must never switch the active hub")

        await vm.hangupCall()
        XCTAssertTrue(
            RelayStubURLProtocol.paths().contains("POST /api/hubs/hub-B/calls/call-b/hangup"),
            "Hang up must target the call's own hub. Requests: \(RelayStubURLProtocol.paths())"
        )
        XCTAssertFalse(RelayStubURLProtocol.paths().contains { $0.contains("/hubs/hub-A/calls/call-b") })
        XCTAssertNil(vm.currentCall)
    }

    // MARK: - Helpers

    private func subscribedHubIds(_ messages: [String]) throws -> [String] {
        try messages.compactMap { text -> String? in
            let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
            guard obj["type"] as? String == "subscribe" else { return nil }
            return obj["hubId"] as? String
        }.sorted()
    }

    private func waitUntil(timeout: TimeInterval = 5, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            try await Task.sleep(for: .milliseconds(50))
            if condition() { return }
        } while Date() < deadline
        XCTFail("Condition not met within \(timeout)s")
    }
}
