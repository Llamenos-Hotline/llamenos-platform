import Foundation
import Testing
@testable import Llamenos

// MARK: - SipStubURLProtocol

/// Stands in for the backend during clock-in. Handlers are keyed by request host so
/// every test owns an isolated fake server (Swift Testing runs suites in parallel).
/// Unmatched paths answer 404, exactly like the real router does for a route that
/// does not exist — which is how the hub-scoped `sip-token` path failed in production.
final class SipStubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var routes: [String: [String: (Int, String)]] = [:]
    private static var log: [String: [String]] = [:]

    /// Install a fake server for `host`: `"METHOD /path"` → (status, JSON body).
    static func install(host: String, routes table: [String: (Int, String)]) {
        lock.lock(); defer { lock.unlock() }
        routes[host] = table
        log[host] = []
    }

    /// Every `"METHOD /path"` the app requested from `host`, in order.
    static func requests(host: String) -> [String] {
        lock.lock(); defer { lock.unlock() }
        return log[host] ?? []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let key = "\(request.httpMethod ?? "GET") \(url.path)"
        Self.lock.lock()
        Self.log[host, default: []].append(key)
        let (status, body) = Self.routes[host]?[key] ?? (404, #"{"error":"Not Found"}"#)
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - RecordingLinphoneService

/// Records every registration attempt together with the credentials handed over,
/// so a test can assert *registration state* — which hubs have an account and that
/// the password actually reached the SIP layer — rather than that a button rendered.
final class RecordingLinphoneService: LinphoneServiceProtocol {
    private(set) var registrations: [(hubId: String, sipParams: SipTokenResponse)] = []
    private(set) var unregisteredHubIds: [String] = []
    private(set) var unregisterAllCount = 0
    /// When set, every registration attempt throws this error.
    var registrationError: Error?

    /// Hubs that currently hold a registration.
    var registeredHubIds: Set<String> {
        Set(registrations.map(\.hubId)).subtracting(unregisteredHubIds)
    }

    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
        if let registrationError { throw registrationError }
        registrations.append((hubId, sipParams))
    }

    func unregisterHubAccount(hubId: String) {
        unregisteredHubIds.append(hubId)
    }

    func unregisterAllHubAccounts() {
        unregisterAllCount += 1
        unregisteredHubIds.append(contentsOf: registrations.map(\.hubId))
    }

    func handleVoipPush(callId: String, hubId: String) {}
}

// MARK: - Fixtures

private func hubJSON(_ id: String, status: String = "active") -> String {
    """
    {"id":"\(id)","name":"Hub \(id)","slug":"\(id)","status":"\(status)",
     "createdAt":"2026-01-01T00:00:00Z","createdBy":"admin","updatedAt":"2026-01-01T00:00:00Z"}
    """
}

/// The body `GET /api/telephony/sip-token` actually returns (`SipConnectionParams`
/// in apps/worker/telephony/sip-tokens.ts), plus the `issuedAt`/`expiresAt` keys #1190
/// adds — unknown keys must not break decoding.
private let sipTokenJSON = """
    {"provider":"asterisk","sip":{"domain":"sip.example.org","transport":"tls",
     "username":"vol_abc","password":"s3cret",
     "iceServers":[{"url":"stun:stun.example.org:3478"}],"mediaEncryption":"zrtp"},
     "issuedAt":"2026-09-27T00:00:00Z","expiresAt":"2026-09-27T01:00:00Z"}
    """

// MARK: - ShiftClockInSipRegistrationTests

/// Issue #1188: after clock-in, a SIP account must be registered for EVERY member hub
/// (multi-hub routing axiom), using the real `/api/telephony/sip-token` route, with the
/// SIP password attached.
@MainActor
struct ShiftClockInSipRegistrationTests {
    private func makeViewModel(
        host: String,
        activeHubId: String,
        linphone: any LinphoneServiceProtocol
    ) -> ShiftsViewModel {
        let hubContext = HubContext()
        hubContext.setActiveHub(activeHubId)
        let crypto = CryptoService()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SipStubURLProtocol.self]
        let api = APIService(cryptoService: crypto, hubContext: hubContext, sessionConfiguration: config)
        api.configure(baseURL: URL(string: "https://\(host)")!)
        return ShiftsViewModel(
            apiService: api,
            cryptoService: crypto,
            hubContext: hubContext,
            linphoneService: linphone
        )
    }

    @Test func clockInRegistersEveryMemberHubWithCredentialsAttached() async {
        let host = "hub-\(UUID().uuidString.lowercased()).test"
        SipStubURLProtocol.install(host: host, routes: [
            "POST /api/shifts/clock-in": (200, #"{"ok":true,"shiftId":"shift-1"}"#),
            "GET /api/hubs": (200, #"{"hubs":[\#(hubJSON("hub-a")),\#(hubJSON("hub-b"))]}"#),
            "GET /api/telephony/sip-token": (200, sipTokenJSON),
        ])
        let linphone = RecordingLinphoneService()
        // hub-a is active; hub-b is a member hub that is NOT active — it must still ring.
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()

        #expect(vm.isOnShift)
        #expect(linphone.registeredHubIds == ["hub-a", "hub-b"])
        #expect(linphone.registrations.allSatisfy { $0.sipParams.sip.password == "s3cret" })
        let requests = SipStubURLProtocol.requests(host: host)
        #expect(requests.contains("GET /api/telephony/sip-token"))
        #expect(!requests.contains { $0.contains("/telephony/sip-token") && $0.contains("/api/hubs/") })
    }

    /// Install the standard fake server: clock-in/out succeed, `hubs` are the member
    /// hubs, and `sip-token` answers with `sipToken`.
    private func installServer(
        host: String,
        hubs: [String] = [hubJSON("hub-a"), hubJSON("hub-b")],
        sipToken: (Int, String) = (200, sipTokenJSON)
    ) {
        SipStubURLProtocol.install(host: host, routes: [
            "POST /api/shifts/clock-in": (200, #"{"ok":true,"shiftId":"shift-1"}"#),
            "POST /api/shifts/clock-out": (200, #"{"ok":true}"#),
            "GET /api/hubs": (200, #"{"hubs":[\#(hubs.joined(separator: ","))]}"#),
            "GET /api/telephony/sip-token": sipToken,
        ])
    }

    private static func freshHost() -> String { "hub-\(UUID().uuidString.lowercased()).test" }

    @Test func clockInRegistersOnlyActiveMemberHubs() async {
        let host = Self.freshHost()
        installServer(host: host, hubs: [
            hubJSON("hub-a"), hubJSON("hub-b"),
            hubJSON("hub-suspended", status: "suspended"),
            hubJSON("hub-archived", status: "archived"),
        ])
        let linphone = RecordingLinphoneService()
        let vm = makeViewModel(host: host, activeHubId: "hub-b", linphone: linphone)

        await vm.clockIn()

        #expect(linphone.registeredHubIds == ["hub-a", "hub-b"])
        #expect(vm.voipWarning == nil)
    }

    @Test func clockInSurfacesMissingSdkInsteadOfSwallowingIt() async {
        let host = Self.freshHost()
        installServer(host: host)
        let linphone = RecordingLinphoneService()
        linphone.registrationError = LinphoneError.sdkNotLinked
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()

        #expect(vm.isOnShift, "clock-in itself succeeded; only calling is unavailable")
        #expect(vm.errorMessage == nil)
        #expect(vm.voipWarning == NSLocalizedString("shifts_voip_unavailable_in_build", comment: ""))
        #expect(linphone.registeredHubIds.isEmpty)
    }

    /// The production `LinphoneService` in this build (SDK not linked) must make that
    /// visible after clock-in — it must never look as if a registration happened.
    @Test func clockInWithRealLinphoneServiceReportsSdkState() async {
        let host = Self.freshHost()
        installServer(host: host)
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: LinphoneService())

        await vm.clockIn()

        #expect(vm.isOnShift)
        if LinphoneService.isSdkLinked {
            // Core not initialized in unit tests → a registration failure, still surfaced.
            #expect(vm.voipWarning == NSLocalizedString("shifts_voip_setup_failed", comment: ""))
        } else {
            #expect(vm.voipWarning == NSLocalizedString("shifts_voip_unavailable_in_build", comment: ""))
        }
    }

    @Test func clockInSurfacesPerHubRegistrationFailure() async {
        let host = Self.freshHost()
        installServer(host: host)
        let linphone = RecordingLinphoneService()
        linphone.registrationError = LinphoneError.accountRegistrationFailed("registrar unreachable")
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()

        #expect(vm.voipWarning == NSLocalizedString("shifts_voip_setup_failed", comment: ""))
    }

    /// A body the client cannot decode — here the flat shape the old hand-written struct
    /// expected and no server ever sent — must be reported, not swallowed by a `try?`.
    @Test func clockInReportsSipCredentialsItCannotDecode() async {
        let host = Self.freshHost()
        let undecodable = #"{"username":"vol_abc","domain":"sip.example.org","password":"s3cret","transport":"tls","expiry":3600}"#
        installServer(host: host, sipToken: (200, undecodable))
        let linphone = RecordingLinphoneService()
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()

        #expect(vm.isOnShift)
        #expect(vm.voipWarning == NSLocalizedString("shifts_voip_setup_failed", comment: ""))
        #expect(linphone.registrations.isEmpty)
    }

    /// 400 from sip-token: the server refuses credentials because the volunteer's call
    /// preference is "phone" (the server default when unset) or no SIP provider exists.
    /// Calls will not ring this device, so that is surfaced — distinctly from a failure.
    @Test func clockInWithSipRefusedByServerRegistersNothingAndSaysSo() async {
        let host = Self.freshHost()
        installServer(host: host, sipToken: (400, #"{"error":"Call preference is set to phone only."}"#))
        let linphone = RecordingLinphoneService()
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()

        #expect(vm.isOnShift)
        #expect(vm.voipWarning == NSLocalizedString("shifts_voip_not_enabled", comment: ""))
        #expect(linphone.registrations.isEmpty)
        #expect(!SipStubURLProtocol.requests(host: host).contains("GET /api/hubs"))
    }

    @Test func clockOutUnregistersEveryMemberHub() async {
        let host = Self.freshHost()
        installServer(host: host)
        let linphone = RecordingLinphoneService()
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()
        #expect(linphone.registeredHubIds == ["hub-a", "hub-b"])
        await vm.clockOut()

        #expect(!vm.isOnShift)
        #expect(linphone.unregisterAllCount == 1)
        #expect(linphone.registeredHubIds.isEmpty, "hub-b must not keep ringing after clock-out")
    }
}
