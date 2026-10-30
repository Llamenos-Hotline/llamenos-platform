import Foundation
import XCTest
@testable import Llamenos

// MARK: - DashboardCallsStubURLProtocol

/// Serves canned `(status, body)` pairs keyed by `METHOD path` and records every request.
/// Private to this file so it never shares static state with other suites' stubs.
private final class DashboardCallsStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responses: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var requested: [String] = []
    /// Keys that are received and then never answered: a connection that hangs.
    nonisolated(unsafe) static var hanging: Set<String> = []
    private static let lock = NSLock()

    static func reset(_ responses: [String: (Int, String)]) {
        lock.lock(); defer { lock.unlock() }
        self.responses = responses
        requested = []
        hanging = []
    }

    static func hang(_ keys: String...) {
        lock.lock(); defer { lock.unlock() }
        hanging.formUnion(keys)
    }

    static func set(_ key: String, _ response: (Int, String)) {
        lock.lock(); defer { lock.unlock() }
        responses[key] = response
    }

    static func requests() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return requested
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        Self.lock.lock()
        Self.requested.append(key)
        let canned = Self.responses[key]
        let hangs = Self.hanging.contains(key)
        Self.lock.unlock()
        if hangs { return }

        let (status, body) = canned ?? (404, #"{"error":"Not Found"}"#)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - DashboardCallsTests

/// What the dashboard makes of the calls a hub lists: a ring is a ring, only a call this
/// device answered is "my call" (hang up / spam / ban are 403 on anyone else's, #2027), my
/// call ending becomes a held, in-memory "Call Ended" prompt (Q5), and answering follows the
/// server's 422 (Q2).
///
/// The stub bodies are the shape `GET /hubs/:hub/calls/active` returns
/// (`activeCallsResponseSchema`).
@MainActor
final class DashboardCallsTests: XCTestCase {

    private let hubA = "hub-A"
    private var crypto = CryptoService()
    private var me: String { crypto.signingPubkeyHex! }
    private let someoneElse = String(repeating: "ab", count: 32)

    override func setUpWithError() throws {
        crypto = CryptoService()
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    // MARK: - Fixtures

    private func call(_ id: String, status: String, answeredBy: String? = nil) -> String {
        let by = answeredBy.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"\#(id)","startedAt":"2026-10-26T10:00:00.000Z","status":"\#(status)","answeredBy":\#(by)}"#
    }

    private func active(_ calls: String...) -> (Int, String) {
        (200, #"{"calls":[\#(calls.joined(separator: ","))]}"#)
    }

    private var activeKey: String { "GET /api/hubs/\(hubA)/calls/active" }
    private var myStatusKey: String { "GET /api/hubs/\(hubA)/shifts/my-status" }

    /// The relay the dashboard under test listens to.
    private var ws: WebSocketService!

    private func makeViewModel(_ responses: [String: (Int, String)]) throws -> DashboardViewModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DashboardCallsStubURLProtocol.self]
        let hubContext = HubContext()
        hubContext.setActiveHub(hubA)
        let api = APIService(cryptoService: crypto, hubContext: hubContext, sessionConfiguration: config)
        try api.configure(hubURLString: "https://hub.example.org")
        DashboardCallsStubURLProtocol.reset(responses)
        ws = WebSocketService(cryptoService: crypto)
        return DashboardViewModel(
            apiService: api,
            cryptoService: crypto,
            webSocketService: ws,
            hubContext: hubContext,
            shiftClockService: ShiftClockService(apiService: api)
        )
    }

    private func sharedCall(_ id: String) throws -> SharedCall {
        try JSONDecoder().decode(SharedCall.self, from: Data(call(id, status: "ringing").utf8))
    }

    // MARK: - A ring is a ring; only my answered call is my call

    func testOnlyACallIAnsweredIsMyCallAndARingIsARing() async throws {
        let vm = try makeViewModel([
            activeKey: active(
                call("ringing-1", status: "ringing"),
                call("theirs-1", status: "in-progress", answeredBy: someoneElse),
                call("mine-1", status: "in-progress", answeredBy: me)
            ),
        ])
        await vm.loadDashboard()

        XCTAssertEqual(vm.ringingCalls.map(\.id), ["ringing-1"], "a ring renders as a ring")
        XCTAssertEqual(vm.currentCall?.id, "mine-1", "not the hub's first call: the one I answered")
        XCTAssertEqual(vm.activeCallCount, 3, "every active call is still counted")
        XCTAssertNil(vm.endedCall)
    }

    func testACallSomeoneElseAnsweredIsNeverMyCall() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("theirs-1", status: "in-progress", answeredBy: someoneElse)),
        ])
        await vm.loadDashboard()

        XCTAssertNil(vm.currentCall, "hang up, spam and ban on it are 403 — it must not be offered")
        XCTAssertTrue(vm.ringingCalls.isEmpty, "an answered call is no longer ringing")
    }

    // MARK: - My call ends

    func testMyCallEndingBecomesAHeldPromptUntilTheNoteIsSavedDismissedOrTheAppLocks() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
        ])
        await vm.loadDashboard()
        XCTAssertEqual(vm.currentCall?.id, "mine-1")

        DashboardCallsStubURLProtocol.set(activeKey, active())
        await vm.refresh()

        XCTAssertNil(vm.currentCall)
        XCTAssertEqual(vm.endedCall?.id, "mine-1", "the call id is held so a note can still be filed")
        XCTAssertEqual(vm.endedCall?.hubId, hubA)
        XCTAssertEqual(vm.heldCalls.map(\.id), ["mine-1"])

        vm.noteSaved(for: try XCTUnwrap(vm.endedCall))
        XCTAssertNil(vm.endedCall, "saving the note finishes the prompt")

        DashboardCallsStubURLProtocol.set(activeKey, active(call("mine-2", status: "in-progress", answeredBy: me)))
        await vm.refresh()
        DashboardCallsStubURLProtocol.set(activeKey, active())
        await vm.refresh()
        XCTAssertEqual(vm.endedCall?.id, "mine-2")
        vm.dismissEndedCall()
        XCTAssertNil(vm.endedCall, "dismissing forgets the call")

        DashboardCallsStubURLProtocol.set(activeKey, active(call("mine-3", status: "in-progress", answeredBy: me)))
        await vm.refresh()
        DashboardCallsStubURLProtocol.set(activeKey, active())
        await vm.refresh()
        XCTAssertEqual(vm.endedCall?.id, "mine-3")
        vm.clearCalls()
        XCTAssertNil(vm.endedCall, "locking or logging out forgets the call")
        XCTAssertTrue(vm.heldCalls.isEmpty)
    }

    // MARK: - The relay says my call ended (#2283)

    /// The decrypted content the server publishes when a call ends — the `/call-status`
    /// webhook, the hang-up route and the test simulator all send exactly this.
    private func callCompleted(_ id: String) -> String {
        #"{"type":"call:update","callId":"\#(id)","status":"completed"}"#
    }

    /// Start the dashboard's relay listener and wait until it is subscribed.
    private func listen(_ vm: DashboardViewModel) async throws {
        let before = ws.attributedListenerCountForTesting
        vm.startEventListener()
        try await waitUntil { self.ws.attributedListenerCountForTesting > before }
    }

    /// The volunteer's call ends while every request after the event hangs. The prompt to
    /// write the call's note must appear from the event alone: before #2283 it was derived
    /// only from a later `calls/active` answer, issued after `shifts/my-status` had
    /// answered, so on a slow connection the volunteer got no prompt and lost the note.
    func testMyCallEndingOnTheRelayPromptsForANoteEvenIfNoRequestEverAnswers() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
        ])
        await vm.loadDashboard()
        XCTAssertEqual(vm.currentCall?.id, "mine-1")
        try await listen(vm)
        defer { vm.stopEventListener() }

        DashboardCallsStubURLProtocol.hang(activeKey, myStatusKey)
        ws.emitDecryptedEventForTesting(hubId: hubA, json: callCompleted("mine-1"))

        try await waitUntil(timeout: 3) { vm.endedCall != nil }
        XCTAssertEqual(vm.endedCall?.id, "mine-1", "the event says the call ended; no fetch is needed to show it")
        XCTAssertEqual(vm.endedCall?.hubId, hubA)
        XCTAssertNil(vm.currentCall, "the call card gives way to the Call Ended prompt")
    }

    /// The reconcile fetches must not wait on each other: `calls/active` is issued even
    /// while `shifts/my-status` hangs.
    func testTheCallListIsReconciledWithoutWaitingForShiftStatus() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
        ])
        await vm.loadDashboard()
        try await listen(vm)
        defer { vm.stopEventListener() }

        DashboardCallsStubURLProtocol.reset([activeKey: active()])
        DashboardCallsStubURLProtocol.hang(myStatusKey)
        ws.emitDecryptedEventForTesting(hubId: hubA, json: callCompleted("mine-1"))

        // `reconcileCalls` starts the two fetches as sibling `async let` tasks, so which one
        // reaches the URL loader first is not defined. Wait for both to be on the wire: the
        // status request is the one that never answers, so `calls/active` having been issued
        // too is exactly "the call list did not wait for shift status".
        try await waitUntil(timeout: 3) {
            let sent = DashboardCallsStubURLProtocol.requests()
            return sent.contains(self.activeKey) && sent.contains(self.myStatusKey)
        }
        let sent = DashboardCallsStubURLProtocol.requests()
        XCTAssertTrue(sent.contains(activeKey), "calls/active is issued while shifts/my-status hangs")
        XCTAssertTrue(sent.contains(myStatusKey), "shifts/my-status is issued, and hangs")
    }

    /// A `calls/active` answer read before the end still lists the call. It must not put
    /// the call back, nor re-raise a prompt the volunteer already dismissed.
    func testAStaleCallListDoesNotResurrectACallTheRelaySaidEnded() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
        ])
        await vm.loadDashboard()
        try await listen(vm)
        defer { vm.stopEventListener() }

        // The server still lists the call (a read that raced the end).
        ws.emitDecryptedEventForTesting(hubId: hubA, json: callCompleted("mine-1"))
        try await waitUntil(timeout: 3) { vm.endedCall != nil }
        vm.dismissEndedCall()
        await vm.refresh()

        XCTAssertNil(vm.currentCall, "an ended call never comes back from a stale list")
        XCTAssertNil(vm.endedCall, "and a dismissed prompt is not raised again")
        XCTAssertEqual(vm.activeCallCount, 0)
    }

    /// A ring that ended (the caller hung up, or it went to voicemail) stops ringing at
    /// once, even if no request answers.
    func testARingTheRelaySaidIsOverStopsRingingWithoutAFetch() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("ring-1", status: "ringing"), call("ring-2", status: "ringing")),
        ])
        await vm.loadDashboard()
        XCTAssertEqual(vm.ringingCalls.map(\.id), ["ring-1", "ring-2"])
        try await listen(vm)
        defer { vm.stopEventListener() }

        DashboardCallsStubURLProtocol.hang(activeKey, myStatusKey)
        ws.emitDecryptedEventForTesting(hubId: hubA, json: callCompleted("ring-1"))
        ws.emitDecryptedEventForTesting(hubId: hubA, json: #"{"type":"voicemail:new","callId":"ring-2"}"#)

        try await waitUntil(timeout: 3) { vm.ringingCalls.isEmpty }
        XCTAssertNil(vm.endedCall, "a ring that was never mine is not a call to write a note about")
    }

    /// An event for a call on another hub with the same id leaves mine alone.
    func testAnEndOnAnotherHubDoesNotEndMyCall() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
        ])
        await vm.loadDashboard()
        try await listen(vm)
        defer { vm.stopEventListener() }

        DashboardCallsStubURLProtocol.hang(activeKey, myStatusKey)
        ws.emitDecryptedEventForTesting(hubId: "hub-B", json: callCompleted("mine-1"))
        ws.emitDecryptedEventForTesting(hubId: hubA, json: #"{"type":"call:update","callId":"mine-1","status":"in-progress"}"#)
        // Both events have been handled once a third, observable one has.
        ws.emitDecryptedEventForTesting(hubId: hubA, json: callCompleted("sentinel"))
        try await waitUntil(timeout: 3) { DashboardCallsStubURLProtocol.requests().filter { $0 == self.activeKey }.count >= 4 }

        XCTAssertEqual(vm.currentCall?.id, "mine-1")
        XCTAssertNil(vm.endedCall)
    }

    func testAHubThatDidNotAnswerDoesNotEndMyCall() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
        ])
        await vm.loadDashboard()

        DashboardCallsStubURLProtocol.set(activeKey, (503, #"{"error":"down"}"#))
        await vm.refresh()

        XCTAssertEqual(vm.currentCall?.id, "mine-1", "an unreachable hub may still hold the call")
        XCTAssertNil(vm.endedCall, "and an unreachable hub is not evidence the call ended")
    }

    func testHangingUpMyCallAlsoPromptsForANote() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
            "POST /api/hubs/\(hubA)/calls/mine-1/hangup": (200, #"{"ok":true}"#),
        ])
        await vm.loadDashboard()
        await vm.hangupCall()

        XCTAssertNil(vm.currentCall)
        XCTAssertEqual(vm.endedCall?.id, "mine-1")
    }

    func testARefusedHangupLeavesTheCallToRetry() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("mine-1", status: "in-progress", answeredBy: me)),
            "POST /api/hubs/\(hubA)/calls/mine-1/hangup": (403, #"{"error":"Not your call"}"#),
        ])
        await vm.loadDashboard()
        await vm.hangupCall()

        XCTAssertEqual(vm.currentCall?.id, "mine-1")
        XCTAssertNil(vm.endedCall)
        XCTAssertNotNil(vm.errorMessage)
    }

    // MARK: - Answering (Q2)

    func testAnswerPostsToTheCallsOwnHubAndA422MeansAnswerOnThePhone() async throws {
        let vm = try makeViewModel([
            "POST /api/hubs/hub-B/calls/ring-1/answer": (422, #"{"error":"answer on your phone"}"#),
        ])
        // The call rings on hub-B while hub-A is the one being browsed.
        let ring = ActiveCall(try sharedCall("ring-1"), hubId: "hub-B")

        await vm.answerCall(ring)

        XCTAssertTrue(
            DashboardCallsStubURLProtocol.requests().contains("POST /api/hubs/hub-B/calls/ring-1/answer"),
            "answer targets the call's hub, not the active hub"
        )
        XCTAssertEqual(vm.answerOnPhoneCallIds, ["ring-1"], "422: the card offers 'answer on your phone'")
        XCTAssertNil(vm.errorMessage, "a 422 is an answer, not an error")
    }

    func testAnswerRefusedForAnotherReasonSaysSoAndKeepsTheRing() async throws {
        let vm = try makeViewModel([
            "POST /api/hubs/\(hubA)/calls/ring-1/answer": (409, #"{"error":"Call already answered"}"#),
            activeKey: active(call("ring-1", status: "ringing")),
        ])
        await vm.loadDashboard()
        await vm.answerCall(try XCTUnwrap(vm.ringingCalls.first))

        XCTAssertTrue(vm.answerOnPhoneCallIds.isEmpty)
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertEqual(vm.ringingCalls.map(\.id), ["ring-1"])
    }

    func testAnsweringInTheAppMakesTheRingMyCall() async throws {
        let vm = try makeViewModel([
            activeKey: active(call("ring-1", status: "ringing")),
            "POST /api/hubs/\(hubA)/calls/ring-1/answer": (200, #"{"call":{}}"#),
        ])
        await vm.loadDashboard()
        DashboardCallsStubURLProtocol.set(activeKey, active(call("ring-1", status: "in-progress", answeredBy: me)))
        await vm.answerCall(try XCTUnwrap(vm.ringingCalls.first))

        XCTAssertEqual(vm.currentCall?.id, "ring-1")
        XCTAssertTrue(vm.ringingCalls.isEmpty)
    }

    // MARK: - Helpers

    private func waitUntil(timeout: TimeInterval = 5, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        } while Date() < deadline
        XCTFail("condition not met within \(timeout)s")
    }
}
