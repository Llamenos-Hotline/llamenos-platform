import Foundation
import XCTest
@testable import Llamenos

// MARK: - ShiftStubURLProtocol

/// Serves canned `(status, body)` pairs keyed by `METHOD path`, and records every request.
/// Private to this file so it never shares static state with other suites' stubs.
private final class ShiftStubURLProtocol: URLProtocol {
    static var responses: [String: (Int, String)] = [:]
    static var requested: [String] = []
    private static let lock = NSLock()

    static func reset(_ responses: [String: (Int, String)]) {
        lock.lock(); defer { lock.unlock() }
        self.responses = responses
        requested = []
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
        Self.lock.unlock()

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

// MARK: - ShiftReadinessTests

/// #2204: iOS showed a shift state the server does not hold, in both directions —
/// "On Shift" for a volunteer who was only scheduled (and therefore not rung), and
/// "Off Shift" after a relaunch for one who was still clocked in (and still rung).
///
/// The stub bodies are the shape `GET /shifts/my-status` returns
/// (`myStatusResponseSchema`: `onShift` = scheduled now, `clockedIn`, `clockedInAt`).
@MainActor
final class ShiftReadinessTests: XCTestCase {

    private let clockedInAt = "2026-10-20T09:30:00.000Z"

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    // MARK: - Fixtures

    private func status(onShift: Bool, clockedIn: Bool) -> String {
        let at = clockedIn ? "\"\(clockedInAt)\"" : "null"
        return #"{"onShift":\#(onShift),"clockedIn":\#(clockedIn),"clockedInAt":\#(at),"currentShift":null,"nextShift":null}"#
    }

    private func me(onBreak: Bool) -> String {
        #"{"pubkey":"abababababababababababababababababababababababababababababababab","roles":[],"onBreak":\#(onBreak)}"#
    }

    private func makeService(
        _ responses: [String: (Int, String)]
    ) throws -> (ShiftClockService, APIService) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ShiftStubURLProtocol.self]
        let api = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)
        try api.configure(hubURLString: "https://hub.example.org")
        ShiftStubURLProtocol.reset(responses)
        return (ShiftClockService(apiService: api), api)
    }

    private func myStatus(_ hubId: String) -> String { "GET /api/hubs/\(hubId)/shifts/my-status" }

    // MARK: - The readiness matrix (mirrors src/client/lib/call-readiness.ts)

    func testReadinessCombinesScheduleClockAndBreakTheWayTheRingSetDoes() {
        func readiness(onShift: Bool, clockedIn: Bool, onBreak: Bool = false) -> ShiftReadiness {
            ShiftReadiness(
                status: MyStatusResponse(clockedIn: clockedIn, clockedInAt: nil, currentShift: nil, nextShift: nil, onShift: onShift),
                onBreak: onBreak
            )
        }
        XCTAssertEqual(readiness(onShift: true, clockedIn: true), .ready)
        XCTAssertEqual(readiness(onShift: true, clockedIn: false), .notClockedIn, "scheduled only is not rung")
        XCTAssertEqual(readiness(onShift: false, clockedIn: true), .unscheduled, "clocked in only is not rung")
        XCTAssertEqual(readiness(onShift: false, clockedIn: false), .offShift)
        for onShift in [true, false] {
            for clockedIn in [true, false] {
                XCTAssertEqual(readiness(onShift: onShift, clockedIn: clockedIn, onBreak: true), .onBreak, "a break beats everything")
            }
        }
    }

    func testBestOfPrefersTheStateClosestToBeingRung() {
        XCTAssertEqual(ShiftReadiness.best(of: [.offShift, .notClockedIn, .ready]), .ready)
        XCTAssertEqual(ShiftReadiness.best(of: [.offShift, .unscheduled]), .unscheduled)
        XCTAssertNil(ShiftReadiness.best(of: []))
    }

    // MARK: - Scheduled-only is not "On Shift"

    func testAScheduledButNotClockedInVolunteerIsNotARingTarget() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: false)),
            "GET /api/auth/me": (200, me(onBreak: false)),
        ])
        await service.refresh(hubIds: ["hub-A"])

        XCTAssertEqual(service.readiness(for: "hub-A"), .notClockedIn)
        XCTAssertEqual(service.readiness(for: "hub-A")?.isRingTarget, false,
                       "the server's ring set is scheduled ∩ clocked in; scheduled alone rings nobody")
        XCTAssertFalse(service.isClockedIn(to: "hub-A"), "the screen must still offer Clock In")
    }

    // MARK: - Survives a restart

    func testAFreshServiceReadsAnExistingClockInFromTheServer() async throws {
        // A relaunch constructs a new service. The old in-memory dictionary came back empty and
        // the Shifts screen said "Off Shift / Clock In" for a volunteer the server still rang.
        let responses = [
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: true)),
            "GET /api/auth/me": (200, me(onBreak: false)),
        ]
        let (relaunched, _) = try makeService(responses)
        XCTAssertNil(relaunched.readiness(for: "hub-A"), "nothing is known before the server answers")

        await relaunched.refresh(hubIds: ["hub-A"])

        XCTAssertTrue(relaunched.isClockedIn(to: "hub-A"))
        XCTAssertEqual(relaunched.readiness(for: "hub-A"), .ready)
        XCTAssertEqual(relaunched.clockedInAt(for: "hub-A"), DateFormatting.parseISO(clockedInAt))
    }

    // MARK: - Break

    func testABreakMeansNotRungWhateverTheShiftSays() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: true)),
            "GET /api/auth/me": (200, me(onBreak: true)),
        ])
        await service.refresh(hubIds: ["hub-A"])
        XCTAssertEqual(service.readiness(for: "hub-A"), .onBreak)
        XCTAssertEqual(service.readiness(for: "hub-A")?.isRingTarget, false)
    }

    // MARK: - Per hub

    func testReadinessIsPerMemberHubAndRingsComeFromAnyOfThem() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: false)),
            myStatus("hub-B"): (200, status(onShift: true, clockedIn: true)),
            "GET /api/auth/me": (200, me(onBreak: false)),
        ])
        await service.refresh(hubIds: ["hub-A", "hub-B"])

        XCTAssertEqual(service.readiness(for: "hub-A"), .notClockedIn)
        XCTAssertEqual(service.readiness(for: "hub-B"), .ready)
        XCTAssertEqual(service.readiness(across: ["hub-A", "hub-B"]), .ready,
                       "being rung on hub B is being rung, whichever hub is browsed")
        XCTAssertEqual(service.readySince(across: ["hub-A", "hub-B"]), DateFormatting.parseISO(clockedInAt))
        XCTAssertNil(service.readySince(across: ["hub-A"]), "no timer for a hub that is not ringing")
    }

    // MARK: - Unknown is not stale

    func testAHubThatStopsAnsweringLosesItsStateInsteadOfKeepingTheLastOne() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: true)),
            "GET /api/auth/me": (200, me(onBreak: false)),
        ])
        await service.refresh(hubIds: ["hub-A"])
        XCTAssertEqual(service.readiness(for: "hub-A"), .ready)

        ShiftStubURLProtocol.set(myStatus("hub-A"), (500, #"{"error":"boom"}"#))
        let failure = await service.refresh(hubIds: ["hub-A"])

        XCTAssertNotNil(failure, "the failure is reported to the caller")
        XCTAssertNil(service.readiness(for: "hub-A"), "an unanswered hub must not keep claiming the last answer")
    }

    // MARK: - Clock in / out read back the server

    func testClockInShowsWhatTheServerNowHolds() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: false, clockedIn: false)),
            "GET /api/auth/me": (200, me(onBreak: false)),
            "POST /api/hubs/hub-A/shifts/clock-in": (200, #"{"ok":true}"#),
        ])
        await service.refresh(hubIds: ["hub-A"])
        XCTAssertFalse(service.isClockedIn(to: "hub-A"))

        ShiftStubURLProtocol.set(myStatus("hub-A"), (200, status(onShift: false, clockedIn: true)))
        try await service.clockIn(hubId: "hub-A")

        XCTAssertTrue(service.isClockedIn(to: "hub-A"))
        XCTAssertEqual(service.readiness(for: "hub-A"), .unscheduled,
                       "clocked in with no covering shift: the server will not ring this volunteer")
    }

    func testClockOutWhenTheServerHoldsNoShiftIsSuccess() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: false, clockedIn: false)),
            "GET /api/auth/me": (200, me(onBreak: false)),
            "POST /api/hubs/hub-A/shifts/clock-out": (404, #"{"error":"No active shift"}"#),
        ])
        try await service.clockOut(hubId: "hub-A")
        XCTAssertFalse(service.isClockedIn(to: "hub-A"))
        XCTAssertEqual(service.readiness(for: "hub-A"), .offShift)
    }

    func testResetForgetsTheStateOfTheUserWhoLeft() async throws {
        let (service, _) = try makeService([
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: true)),
            "GET /api/auth/me": (200, me(onBreak: true)),
        ])
        await service.refresh(hubIds: ["hub-A"])
        service.reset()
        XCTAssertNil(service.readiness(for: "hub-A"))
        XCTAssertFalse(service.onBreak)
    }

    // MARK: - Dashboard

    func testTheDashboardReadsTheSameStateAcrossEveryMemberHub() async throws {
        let ctx = HubContext()
        ctx.setActiveHub("hub-A")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ShiftStubURLProtocol.self]
        let api = APIService(cryptoService: CryptoService(), hubContext: ctx, sessionConfiguration: config)
        try api.configure(hubURLString: "https://hub.example.org")
        ShiftStubURLProtocol.reset([
            myStatus("hub-A"): (200, status(onShift: true, clockedIn: false)),
            myStatus("hub-B"): (200, status(onShift: true, clockedIn: true)),
            "GET /api/auth/me": (200, me(onBreak: false)),
            "GET /api/hubs/hub-A/calls/active": (200, #"{"calls":[]}"#),
            "GET /api/hubs/hub-B/calls/active": (200, #"{"calls":[]}"#),
            "GET /api/hubs/hub-A/notes": (200, #"{"notes":[],"total":0,"page":1,"limit":3}"#),
        ])
        let ws = WebSocketService(cryptoService: CryptoService())
        ws.receiveServerMessageForTesting(#"{"type":"authenticated","hubs":["hub-A","hub-B","global"]}"#)
        let service = ShiftClockService(apiService: api)
        let vm = DashboardViewModel(
            apiService: api,
            cryptoService: CryptoService(),
            webSocketService: ws,
            hubContext: ctx,
            shiftClockService: service
        )
        XCTAssertNil(vm.readiness, "unknown until the server answers — not defaulted to a shift state")

        await vm.loadDashboard()

        XCTAssertEqual(vm.readiness, .ready, "hub B rings this volunteer even though hub A is the one browsed")
        XCTAssertEqual(vm.shiftStartedAt, DateFormatting.parseISO(clockedInAt))
        XCTAssertTrue(ShiftStubURLProtocol.requests().contains(myStatus("hub-B")),
                      "shift state is read from every member hub. Requests: \(ShiftStubURLProtocol.requests())")
        vm.stopEventListener()
    }
}
