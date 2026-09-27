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

    /// Hubs that currently hold a registration.
    var registeredHubIds: Set<String> {
        Set(registrations.map(\.hubId)).subtracting(unregisteredHubIds)
    }

    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
        registrations.append((hubId, sipParams))
    }

    func unregisterHubAccount(hubId: String) {
        unregisteredHubIds.append(hubId)
    }

    func handleVoipPush(callId: String, hubId: String) {}
}

// MARK: - ShiftClockInSipRegistrationTests

/// Issue #1188: after clock-in, a SIP account must be registered for EVERY member hub
/// (multi-hub routing axiom), using the real `/api/telephony/sip-token` route, with the
/// SIP password attached.
@MainActor
struct ShiftClockInSipRegistrationTests {
    private static func hubJSON(_ id: String, status: String = "active") -> String {
        """
        {"id":"\(id)","name":"Hub \(id)","slug":"\(id)","status":"\(status)",
         "createdAt":"2026-01-01T00:00:00Z","createdBy":"admin","updatedAt":"2026-01-01T00:00:00Z"}
        """
    }

    private static let sipTokenJSON = """
        {"username":"vol_abc","domain":"sip.example.org","password":"s3cret",
         "transport":"tls","expiry":3600}
        """

    private func makeViewModel(
        host: String,
        activeHubId: String,
        linphone: RecordingLinphoneService
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
            "GET /api/hubs": (200, #"{"hubs":[\#(Self.hubJSON("hub-a")),\#(Self.hubJSON("hub-b"))]}"#),
            "GET /api/telephony/sip-token": (200, Self.sipTokenJSON),
        ])
        let linphone = RecordingLinphoneService()
        // hub-a is active; hub-b is a member hub that is NOT active — it must still ring.
        let vm = makeViewModel(host: host, activeHubId: "hub-a", linphone: linphone)

        await vm.clockIn()

        #expect(vm.isOnShift)
        #expect(linphone.registeredHubIds == ["hub-a", "hub-b"])
        #expect(linphone.registrations.allSatisfy { $0.sipParams.password == "s3cret" })
        let requests = SipStubURLProtocol.requests(host: host)
        #expect(requests.contains("GET /api/telephony/sip-token"))
        #expect(!requests.contains { $0.contains("/telephony/sip-token") && $0.contains("/api/hubs/") })
    }
}
