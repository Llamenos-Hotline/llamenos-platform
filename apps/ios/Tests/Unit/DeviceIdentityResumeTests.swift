import Foundation
import XCTest
@testable import Llamenos

// MARK: - SigchainServerURLProtocol

/// One user's sigchain and PUK envelopes, served the way the real routes serve them:
/// an append that is not off the head is refused with 409, envelopes are upserted
/// on (device, generation), and the next envelope POST can be made to fail.
/// Registered per session (protocolClasses), never globally.
private final class SigchainServerURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var links: [[String: Any]] = []
    private static var envelopes: [[String: Any]] = []
    private static var failNextEnvelopePost = false

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        links = []
        envelopes = []
        failNextEnvelopePost = false
    }

    static func failTheNextEnvelopePost() {
        lock.lock(); defer { lock.unlock() }
        failNextEnvelopePost = true
    }

    static var storedLinks: [[String: Any]] {
        get { lock.lock(); defer { lock.unlock() }; return links }
        set { lock.lock(); defer { lock.unlock() }; links = newValue }
    }

    static var storedEnvelopes: [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return envelopes
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let data = request.httpBody ?? request.httpBodyStream.map(Self.readStream) ?? Data()
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let path = request.url?.path ?? ""
        let (status, json) = Self.answer(method: request.httpMethod ?? "GET", path: path, body: body)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func answer(method: String, path: String, body: [String: Any]) -> (Int, Any) {
        lock.lock(); defer { lock.unlock() }
        if path.hasSuffix("/sigchain"), method == "GET" {
            return (200, ["links": links])
        }
        if path.hasSuffix("/sigchain"), method == "POST" {
            let head = links.last
            let headSeq = head?["seqNo"] as? Int ?? 0
            guard body["seqNo"] as? Int == headSeq + 1 else { return (409, ["error": "sequence mismatch"]) }
            guard body["prevHash"] as? String == head?["hash"] as? String else {
                return (409, ["error": "prevHash mismatch"])
            }
            var record = body
            record["id"] = UUID().uuidString.lowercased()
            record["userPubkey"] = path.split(separator: "/").dropLast().last.map(String.init) ?? ""
            record["createdAt"] = "2026-11-27T00:00:00Z"
            record["prevHash"] = body["prevHash"] ?? NSNull()
            links.append(record)
            return (201, record)
        }
        if path.hasSuffix("/api/puk/envelopes"), method == "POST" {
            if failNextEnvelopePost {
                failNextEnvelopePost = false
                return (503, ["error": "unavailable"])
            }
            let sent = body["envelopes"] as? [[String: Any]] ?? []
            for e in sent {
                envelopes.removeAll {
                    $0["deviceId"] as? String == e["deviceId"] as? String && $0["generation"] as? Int == e["generation"] as? Int
                }
                envelopes.append(e)
            }
            return (200, ["distributed": sent.count, "envelopes": [Any]()])
        }
        return (404, ["error": "not found"])
    }

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

// MARK: - DeviceIdentityResumeTests

/// #3051: `DeviceIdentityService.ensureIdentity` finishes an identity initialisation
/// that stopped part-way, and a restore of another identity does not leave it
/// failing closed.
///
/// The `puk_epoch` link binds the PUK's public keys into the chain; a chain with
/// genesis but no `puk_epoch` leaves the generation-1 envelope with nothing to be
/// checked against, so it must be resumed — not verified as if finished.
///
/// Everything cryptographic is the app's own path over UniFFI into packages/crypto:
/// the genesis, the PUK and the links are made by Rust, and the chain the
/// assertions read back is verified by the crate's `verify_sigchain`.
@MainActor
final class DeviceIdentityResumeTests: XCTestCase {

    private let pin = "13572468"
    private let newPin = "86427531"
    private var crypto: CryptoService!
    private var api: APIService!
    private var keychain: KeychainService!

    private static let keychainKeys = [
        KeychainKey.sigchainHead, KeychainKey.encryptedKeys, KeychainKey.deviceID, KeychainKey.biometricEnabled,
    ]

    override func setUp() async throws {
        try await super.setUp()
        SigchainServerURLProtocol.reset()
        keychain = KeychainService()
        for key in Self.keychainKeys { keychain.delete(key: key) }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SigchainServerURLProtocol.self]
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false

        crypto = CryptoService()
        api = APIService(cryptoService: crypto, hubContext: HubContext(), sessionConfiguration: config)
        api.configure(baseURL: URL(string: "https://hub.example.org")!)
    }

    override func tearDown() async throws {
        crypto.lock()
        for key in Self.keychainKeys { keychain.delete(key: key) }
        SigchainServerURLProtocol.reset()
        try await super.tearDown()
    }

    private func identity() -> DeviceIdentityService {
        DeviceIdentityService(apiService: api, cryptoService: crypto, keychainService: keychain)
    }

    /// Stop an initialisation after its genesis: the PUK envelope POST fails.
    private func strandAfterGenesis() async throws {
        SigchainServerURLProtocol.failTheNextEnvelopePost()
        do {
            try await identity().ensureIdentity()
            XCTFail("the envelope POST was refused, so initialisation cannot have finished")
        } catch {}
        XCTAssertEqual(SigchainServerURLProtocol.storedLinks.map { $0["linkType"] as? String }, ["genesis"])
    }

    /// The server's chain in the crate's `SigchainLink` JSON shape.
    private func serverChainJson() throws -> String {
        let links = SigchainServerURLProtocol.storedLinks.map { l -> [String: Any] in
            let payload = String(decoding: (try? JSONSerialization.data(withJSONObject: l["payload"] ?? [:])) ?? Data(), as: UTF8.self)
            return [
                "id": l["id"] ?? "", "seq": l["seqNo"] ?? 0, "prevHash": l["prevHash"] ?? NSNull(),
                "entryHash": l["hash"] ?? "", "signerDeviceId": l["signerDeviceId"] ?? "",
                "signerPubkey": l["signerPubkey"] ?? "", "signature": l["signature"] ?? "",
                "timestamp": l["timestamp"] ?? "", "payloadJson": payload,
            ]
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: links), as: UTF8.self)
    }

    /// The server's chain is complete and verifies in Rust: genesis then a
    /// generation-1 `puk_epoch`, the envelope stored for this device, and this
    /// device recorded the chain's head.
    private func assertCompleteChain(file: StaticString = #filePath, line: UInt = #line) throws {
        let links = SigchainServerURLProtocol.storedLinks
        XCTAssertEqual(links.map { $0["linkType"] as? String }, ["genesis", "puk_epoch"], file: file, line: line)
        let verified = try crypto.verifySigchain(linksJson: try serverChainJson())
        let user = try XCTUnwrap(crypto.signingPubkeyHex)
        XCTAssertEqual(verified.userPubkey, user, file: file, line: line)
        XCTAssertEqual(verified.headSeq, 2, file: file, line: line)
        let epoch = try XCTUnwrap(links.last?["payload"] as? [String: Any])
        XCTAssertEqual(epoch["type"] as? String, "puk_epoch", file: file, line: line)
        XCTAssertEqual(epoch["generation"] as? Int, 1, file: file, line: line)
        XCTAssertNotNil(epoch["signPubkey"] as? String, file: file, line: line)
        XCTAssertNotNil(epoch["dhPubkey"] as? String, file: file, line: line)
        let stored = SigchainServerURLProtocol.storedEnvelopes.map { "\($0["deviceId"] ?? ""):\($0["generation"] ?? "")" }
        XCTAssertEqual(stored, ["\(crypto.deviceId ?? ""):1"], file: file, line: line)
        XCTAssertEqual(
            try keychain.retrieveString(key: KeychainKey.sigchainHead), "\(user):2:\(verified.headHash)",
            file: file, line: line
        )
    }

    // MARK: - Resume

    func testAGenesisOnlyChainIsResumedToItsPukEpoch() async throws {
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        try await strandAfterGenesis()

        try await identity().ensureIdentity()

        try assertCompleteChain()
    }

    func testAGenesisOnlyChainThisDeviceRecordedAsItsHeadIsResumed() async throws {
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        try await strandAfterGenesis()
        // A build that took the stranded chain as initialised verified it and kept its head.
        let genesisHash = try XCTUnwrap(SigchainServerURLProtocol.storedLinks.first?["hash"] as? String)
        try keychain.storeString("\(crypto.signingPubkeyHex ?? ""):1:\(genesisHash)", key: KeychainKey.sigchainHead)

        try await identity().ensureIdentity()

        try assertCompleteChain()
    }

    func testAServedGenesisThatDoesNotVerifyIsNotExtendedAndGetsNoPuk() async throws {
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        try await strandAfterGenesis()
        // The server now serves a genesis naming another X-Wing key: its hash no longer matches.
        var links = SigchainServerURLProtocol.storedLinks
        var payload = try XCTUnwrap(links[0]["payload"] as? [String: Any])
        payload["encryptionPubkey"] = String(repeating: "ab", count: 1216)
        links[0]["payload"] = payload
        SigchainServerURLProtocol.storedLinks = links

        do {
            try await identity().ensureIdentity()
            XCTFail("a genesis that does not verify must not be extended")
        } catch {}

        XCTAssertEqual(SigchainServerURLProtocol.storedLinks.count, 1)
        XCTAssertEqual(SigchainServerURLProtocol.storedLinks.first?["hash"] as? String, links[0]["hash"] as? String)
        XCTAssertTrue(SigchainServerURLProtocol.storedEnvelopes.isEmpty)
    }

    // MARK: - Restore

    func testRestoringAnotherIdentityClearsItsHeadAndEnsureIdentityCompletes() async throws {
        // Identity B's backup, made elsewhere.
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        let recoveryKey = crypto.generateRecoveryKey()
        let backup = try crypto.createBackup(pin: pin, recoveryKey: recoveryKey)
        crypto.lock()
        // Identity A verified its chain on this phone and recorded the head.
        let previousUser = String(repeating: "7a", count: 32)
        try keychain.storeString("\(previousUser):3:\(String(repeating: "9", count: 64))", key: KeychainKey.sigchainHead)

        let auth = AuthService(cryptoService: crypto, keychainService: keychain)
        let restored = try auth.restoreIdentity(
            backupJson: backup, credential: recoveryKey, isRecoveryKey: true, pin: newPin
        )

        XCTAssertNil(try keychain.retrieveString(key: KeychainKey.sigchainHead))
        XCTAssertTrue(auth.hasStoredKeys)
        XCTAssertEqual(try keychain.retrieveString(key: KeychainKey.deviceID), restored.deviceId)
        try await identity().ensureIdentity()
        try assertCompleteChain()
        // The stored blob is the restored identity, under the new PIN.
        crypto.lock()
        try auth.unlockWithPIN(newPin)
        XCTAssertEqual(crypto.signingPubkeyHex, restored.signingPubkeyHex)
    }

    func testRestoringTheSameIdentityKeepsItsHeadAsTheRollbackGuard() async throws {
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        try await identity().ensureIdentity()
        let head = try keychain.retrieveString(key: KeychainKey.sigchainHead)
        XCTAssertNotNil(head)
        let recoveryKey = crypto.generateRecoveryKey()
        let backup = try crypto.createBackup(pin: pin, recoveryKey: recoveryKey)
        crypto.lock()

        let auth = AuthService(cryptoService: crypto, keychainService: keychain)
        _ = try auth.restoreIdentity(backupJson: backup, credential: recoveryKey, isRecoveryKey: true, pin: newPin)

        XCTAssertEqual(try keychain.retrieveString(key: KeychainKey.sigchainHead), head)
        // The guard still holds: a server that rolls the chain back is refused, not re-initialised.
        SigchainServerURLProtocol.storedLinks = []
        do {
            try await identity().ensureIdentity()
            XCTFail("a rolled-back chain must be refused")
        } catch DeviceIdentityService.IdentityError.chainRolledBack {}
        XCTAssertTrue(SigchainServerURLProtocol.storedLinks.isEmpty)
    }
}
