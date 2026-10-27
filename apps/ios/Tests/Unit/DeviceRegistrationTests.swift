import Foundation
import XCTest
@testable import Llamenos

// MARK: - RegistrationStubURLProtocol

/// Answers `POST /api/devices/register` from a scripted queue of status codes and
/// records every request it sees. Registered per session (protocolClasses), never
/// globally, so no other suite's traffic reaches it.
private final class RegistrationStubURLProtocol: URLProtocol {
    struct Seen {
        let path: String
        let authorization: String?
        let body: [String: Any]
    }

    private static let lock = NSLock()
    private static var statuses: [Int] = []
    private static var seen: [Seen] = []

    static func reset(statuses: [Int]) {
        lock.lock(); defer { lock.unlock() }
        self.statuses = statuses
        seen = []
    }

    static func requests() -> [Seen] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let data = request.httpBody ?? request.httpBodyStream.map(Self.readStream) ?? Data()
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]

        Self.lock.lock()
        Self.seen.append(Seen(
            path: request.url?.path ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: body
        ))
        let status = Self.statuses.isEmpty ? 204 : Self.statuses.removeFirst()
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if status != 204 {
            client?.urlProtocol(self, didLoad: Data(#"{"error":"stubbed"}"#.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

// MARK: - DeviceRegistrationTests

/// #2201 — the server must hold this device's X25519/Ed25519 keys, or it has nothing to
/// seal to and every envelope addressed to an iOS user is undeliverable.
///
/// These drive the real `WakeKeyService` → `APIService` path against a stubbed socket and
/// assert the request that leaves it: the keys in the body and the signature on it.
@MainActor
final class DeviceRegistrationTests: XCTestCase {

    private var crypto: CryptoService!
    private var api: APIService!
    private var keychain: KeychainService!
    private var service: WakeKeyService!

    override func setUp() async throws {
        try await super.setUp()
        RegistrationStubURLProtocol.reset(statuses: [])

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RegistrationStubURLProtocol.self]
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never

        keychain = KeychainService()
        for key in ["wake-private-key", "wake-public-key", "device-registered"] { keychain.delete(key: key) }

        crypto = CryptoService()
        crypto.lock()
        api = APIService(cryptoService: crypto, hubContext: HubContext(), sessionConfiguration: config)
        api.configure(baseURL: URL(string: "https://hub.example.org")!)
        service = WakeKeyService(
            keychainService: keychain,
            cryptoService: crypto,
            apiService: api,
            retryDelays: [.milliseconds(60)]
        )
    }

    override func tearDown() async throws {
        service.cancelRegistration()
        crypto.lock()
        service = nil
        api = nil
        crypto = nil
        keychain = nil
        RegistrationStubURLProtocol.reset(statuses: [])
        try await super.tearDown()
    }

    private func unlock() throws {
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        XCTAssertTrue(crypto.isUnlocked)
    }

    /// Polls a condition with the run loop spinning — no fixed sleeps (a retry's timing
    /// is not the thing under test).
    private func waitUntil(_ description: String, timeout: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), "timed out waiting for: \(description)")
    }

    // MARK: - Locked

    func testLockedDeviceSendsNothingAndSaysWhy() async throws {
        service.updatePushToken("aabbcc")
        service.registerDeviceIfUnlocked()

        do {
            try await service.registerDevice()
            XCTFail("a locked device must not register")
        } catch WakeKeyError.deviceLocked {
            // expected
        }

        XCTAssertFalse(service.isRegistering)
        XCTAssertTrue(
            RegistrationStubURLProtocol.requests().isEmpty,
            "an unsigned registration is a guaranteed 401; nothing may be sent while locked"
        )
    }

    func testTokenArrivingWhileLockedIsHeldAndRegisteredWithTheKeysOnUnlock() async throws {
        service.updatePushToken("aabbcc")
        XCTAssertTrue(RegistrationStubURLProtocol.requests().isEmpty)

        try unlock()
        service.registerDeviceIfUnlocked()
        await waitUntil("registration after unlock") { RegistrationStubURLProtocol.requests().count == 1 }

        let request = try XCTUnwrap(RegistrationStubURLProtocol.requests().first)
        XCTAssertEqual(request.body["pushToken"] as? String, "aabbcc")
        XCTAssertEqual(request.body["x25519Pubkey"] as? String, crypto.encryptionPubkeyHex)
    }

    // MARK: - Body

    func testRegistrationIsSignedAndCarriesBothDeviceKeysWithoutAPushToken() async throws {
        try unlock()

        try await service.registerDevice()

        let requests = RegistrationStubURLProtocol.requests()
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/devices/register")
        XCTAssertTrue(
            request.authorization?.hasPrefix("Bearer ") == true,
            "registration must be signed — an unsigned one is refused with 401 missing_credentials"
        )
        XCTAssertEqual(request.body["platform"] as? String, "ios")
        XCTAssertEqual(request.body["x25519Pubkey"] as? String, crypto.encryptionPubkeyHex)
        XCTAssertEqual(request.body["ed25519Pubkey"] as? String, crypto.signingPubkeyHex)
        XCTAssertNil(request.body["pushToken"], "identity must not depend on APNs having produced a token")
        XCTAssertNil(request.body["wakeKeyPublic"])
        XCTAssertNil(request.body["deviceId"], "the contract does not carry deviceId; do not send it")
    }

    func testBodyNeverCarriesEmptyKeys() async throws {
        try unlock()
        let body = try service.registrationBody()

        XCTAssertEqual(body.x25519Pubkey?.count, 64)
        XCTAssertEqual(body.ed25519Pubkey?.count, 64)
        XCTAssertTrue(body.x25519Pubkey?.allSatisfy(\.isHexDigit) == true)
        XCTAssertTrue(body.ed25519Pubkey?.allSatisfy(\.isHexDigit) == true)
    }

    func testPushTokenArrivalRegistersTokenWakeKeyAndIdentityTogether() async throws {
        try unlock()
        try await service.registerDevice()

        service.updatePushToken("aabbcc")
        await waitUntil("second registration with the token") { RegistrationStubURLProtocol.requests().count == 2 }

        let request = try XCTUnwrap(RegistrationStubURLProtocol.requests().last)
        XCTAssertEqual(request.body["pushToken"] as? String, "aabbcc")
        XCTAssertEqual(request.body["wakeKeyPublic"] as? String, service.publicKeyHex)
        XCTAssertEqual(request.body["x25519Pubkey"] as? String, crypto.encryptionPubkeyHex)
        XCTAssertEqual(request.body["ed25519Pubkey"] as? String, crypto.signingPubkeyHex)
    }

    // MARK: - Idempotence

    func testAnUnchangedRegistrationIsNotSentAgain() async throws {
        try unlock()

        try await service.registerDevice()
        try await service.registerDevice()
        service.registerDeviceIfUnlocked()
        await waitUntil("idle") { !self.service.isRegistering }

        XCTAssertEqual(
            RegistrationStubURLProtocol.requests().count, 1,
            "the endpoint is rate-limited to 5/hour; an unlock that changes nothing must not spend a request"
        )
    }

    // MARK: - Retry

    func testATransientFailureIsRetriedAndSurfacedUntilTheServerAccepts() async throws {
        try unlock()
        RegistrationStubURLProtocol.reset(statuses: [503, 401])

        service.registerDeviceIfUnlocked()
        await waitUntil("failure surfaced") { self.service.registrationError != nil }
        await waitUntil("third attempt accepted") { RegistrationStubURLProtocol.requests().count == 3 }
        await waitUntil("retry loop finished") { !self.service.isRegistering }

        XCTAssertNil(service.registrationError, "success clears the surfaced failure")
        XCTAssertTrue(service.isRegistered)
    }

    func testARejectedBodyIsNotRetriedButStaysSurfaced() async throws {
        try unlock()
        RegistrationStubURLProtocol.reset(statuses: [400])

        service.registerDeviceIfUnlocked()
        await waitUntil("loop stopped") { !self.service.isRegistering }

        XCTAssertEqual(RegistrationStubURLProtocol.requests().count, 1, "the same body cannot succeed on a retry")
        XCTAssertNotNil(service.registrationError)
        XCTAssertFalse(service.isRegistered)
    }

    func testLockingStopsTheRetryLoop() async throws {
        try unlock()
        RegistrationStubURLProtocol.reset(statuses: Array(repeating: 503, count: 50))

        service.registerDeviceIfUnlocked()
        await waitUntil("first attempt") { RegistrationStubURLProtocol.requests().count >= 1 }

        service.cancelRegistration()
        crypto.lock()
        let afterLock = RegistrationStubURLProtocol.requests().count
        try await Task.sleep(for: .milliseconds(200))

        XCTAssertFalse(service.isRegistering)
        XCTAssertLessThanOrEqual(
            RegistrationStubURLProtocol.requests().count, afterLock + 1,
            "no attempts may continue once the device is locked"
        )
    }
}
