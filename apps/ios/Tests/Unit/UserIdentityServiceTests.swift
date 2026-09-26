import XCTest
@testable import Llamenos

/// Identity initialisation (PROTOCOL.md §2.11) with the real packages/crypto
/// XCFramework. Only HTTP is replaced: `InMemoryIdentityServer` stores what the
/// client appends and enforces the server's append rules (401 until the user is
/// registered, genesis at seq 1, seq/prevHash continuity). Every assertion reads the
/// stored chain back and checks it with packages/crypto — `verify_sigchain` and a PUK
/// envelope open + subkey derivation — so a pass means the chain verifies.
final class UserIdentityServiceTests: XCTestCase {

    private var crypto: CryptoService!
    private var server: InMemoryIdentityServer!
    private var service: UserIdentityService!

    override func setUpWithError() throws {
        try super.setUpWithError()
        crypto = CryptoService()
        crypto.lock()
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        server = InMemoryIdentityServer()
        service = UserIdentityService(cryptoService: crypto, api: server)
    }

    override func tearDown() {
        crypto.lock()
        super.tearDown()
    }

    private var userPubkey: String { crypto.signingPubkeyHex! }

    func testDefersUntilTheServerKnowsTheUser() async throws {
        guard case .notRegistered = try await service.ensureInitialized() else {
            return XCTFail("An unregistered user must defer initialisation")
        }
        server.register(userPubkey)
        XCTAssertTrue(server.chain(for: userPubkey).isEmpty, "Nothing may be written before registration")
    }

    func testNewUserGetsAVerifyingGenesisLinkAndPuk() async throws {
        server.register(userPubkey)

        guard case .verified(let state) = try await service.ensureInitialized() else {
            return XCTFail("Initialisation must verify the chain")
        }
        XCTAssertEqual(state.headSeq, 2)

        let chain = server.chain(for: userPubkey)
        XCTAssertEqual(chain.map { "\($0.seqNo):\($0.linkType)" }, ["1:genesis", "2:puk_epoch"])

        // The stored chain verifies independently of the service's own check.
        let verified = try crypto.verifySigchain(links: try chain.map(UserIdentityService.cryptoLink))
        XCTAssertEqual(verified.verifiedCount, 2)
        XCTAssertEqual(verified.headHash, chain.last?.hash)
        XCTAssertEqual(verified.activeDevicePubkeys, [userPubkey])

        // The genesis names this device's keys.
        let genesis = try UserIdentityService.decodePayload(SigchainGenesisPayload.self, of: chain[0])
        XCTAssertEqual(genesis.deviceID, crypto.deviceId)
        XCTAssertEqual(genesis.devicePubkey, userPubkey)
        XCTAssertEqual(genesis.deviceEncryptionPubkey, crypto.encryptionPubkeyHex)
        XCTAssertEqual(chain[0].signerPubkey, userPubkey)

        // The device opens its PUK envelope to the keys the chain names.
        let epoch = try UserIdentityService.decodePayload(SigchainPukEpochPayload.self, of: chain[1])
        let envelope = try XCTUnwrap(server.envelope(for: userPubkey, deviceId: crypto.deviceId!))
        XCTAssertEqual(envelope.generation, epoch.generation)
        let seedHex = try crypto.unwrapPukSeed(envelope: envelope.envelope)
        let derived = try crypto.derivePukState(seedHex: seedHex, generation: envelope.generation)
        XCTAssertEqual(derived.signPubkeyHex, epoch.signPubkey)
        XCTAssertEqual(derived.dhPubkeyHex, epoch.dhPubkey)
    }

    func testInitialisingAnExistingIdentityAddsNoLinks() async throws {
        server.register(userPubkey)
        _ = try await service.ensureInitialized()
        let before = server.chain(for: userPubkey).map(\.hash)

        guard case .verified = try await service.ensureInitialized() else {
            return XCTFail("A second run must still verify")
        }
        XCTAssertEqual(server.chain(for: userPubkey).map(\.hash), before)
    }

    func testResumesAfterGenesisWithoutPuk() async throws {
        server.register(userPubkey)
        server.failPukEnvelopeWrites = true
        do {
            _ = try await service.ensureInitialized()
            XCTFail("A failed envelope write must fail initialisation")
        } catch {}
        XCTAssertEqual(server.chain(for: userPubkey).map(\.linkType), ["genesis"],
                       "The chain must not claim a PUK whose envelope was not stored")

        server.failPukEnvelopeWrites = false
        guard case .verified = try await service.ensureInitialized() else {
            return XCTFail("The retry must resume and verify")
        }
        XCTAssertEqual(server.chain(for: userPubkey).map(\.linkType), ["genesis", "puk_epoch"])
    }

    func testTamperedStoredChainFailsVerification() async throws {
        server.register(userPubkey)
        _ = try await service.ensureInitialized()
        server.tamperGenesisDeviceEncryptionPubkey(for: userPubkey)

        do {
            _ = try await service.ensureInitialized()
            XCTFail("A chain whose genesis payload no longer matches its hash must not verify")
        } catch {}
    }
}

// MARK: - InMemoryIdentityServer

/// Stores sigchain links and PUK envelopes as the server would, enforcing its append
/// rules. It does not verify hashes or signatures — packages/crypto does that in the
/// assertions, exactly as the client does against the real server.
private final class InMemoryIdentityServer: UserIdentityAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var registered: Set<String> = []
    private var chains: [String: [SigchainResponseLink]] = [:]
    private var envelopes: [String: PukEnvelopeItem] = [:]
    var failPukEnvelopeWrites = false

    func register(_ pubkey: String) {
        lock.withLock { _ = registered.insert(pubkey) }
    }

    func chain(for pubkey: String) -> [SigchainResponseLink] {
        lock.withLock { chains[pubkey] ?? [] }
    }

    func envelope(for pubkey: String, deviceId: String) -> PukEnvelopeItem? {
        lock.withLock { envelopes["\(pubkey)/\(deviceId)"] }
    }

    func tamperGenesisDeviceEncryptionPubkey(for pubkey: String) {
        lock.withLock {
            guard var chain = chains[pubkey], let genesis = chain.first else { return }
            var payload = (genesis.payload.value as? [String: Any]) ?? [:]
            payload["deviceEncryptionPubkey"] = String(repeating: "0", count: 64)
            chain[0] = Self.link(genesis, payload: Self.jsonAny(payload))
            chains[pubkey] = chain
        }
    }

    private func requireRegistered(_ pubkey: String) throws {
        guard registered.contains(pubkey) else {
            throw APIError.requestFailed(statusCode: 401, body: #"{"error":"Authentication failed"}"#)
        }
    }

    func getSigchain(userPubkey: String) async throws -> SigchainResponse {
        try lock.withLock {
            try requireRegistered(userPubkey)
            return SigchainResponse(links: chains[userPubkey] ?? [])
        }
    }

    func appendSigchainLink(userPubkey: String, body: AppendSigchainLinkBody) async throws {
        try lock.withLock {
            try requireRegistered(userPubkey)
            let chain = chains[userPubkey] ?? []
            let expectedSeq = (chain.last?.seqNo ?? 0) + 1
            guard body.seqNo == expectedSeq, body.prevHash == (chain.last?.hash ?? "") else {
                throw APIError.requestFailed(statusCode: 409, body: "sequence mismatch")
            }
            guard (body.linkType == .genesis) == (body.seqNo == UserIdentityService.genesisSeq) else {
                throw APIError.requestFailed(statusCode: 400, body: "genesis only at seq 1")
            }
            let payload = try JSONDecoder().decode(JSONAny.self, from: try JSONEncoder().encode(body.payload))
            let record = SigchainResponseLink(
                createdAt: body.timestamp,
                hash: body.hash,
                id: UUID().uuidString,
                linkType: body.linkType.rawValue,
                payload: payload,
                prevHash: body.prevHash,
                seqNo: body.seqNo,
                signature: body.signature,
                signerDeviceID: body.signerDeviceID,
                signerPubkey: body.signerPubkey,
                timestamp: body.timestamp,
                userPubkey: userPubkey
            )
            chains[userPubkey] = chain + [record]
        }
    }

    func distributePukEnvelopes(_ body: DistributePukEnvelopesBody) async throws {
        guard !failPukEnvelopeWrites else {
            throw APIError.requestFailed(statusCode: 500, body: "storage unavailable")
        }
        // The real route authenticates the caller; here the single registered user owns it.
        lock.withLock {
            guard let owner = registered.first else { return }
            for item in body.envelopes {
                envelopes["\(owner)/\(item.deviceID)"] = PukEnvelopeItem(
                    deviceID: item.deviceID,
                    envelope: item.envelope,
                    generation: item.generation
                )
            }
        }
    }

    private static func jsonAny(_ object: [String: Any]) -> JSONAny {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(JSONAny.self, from: data)
    }

    private static func link(_ link: SigchainResponseLink, payload: JSONAny) -> SigchainResponseLink {
        SigchainResponseLink(
            createdAt: link.createdAt, hash: link.hash, id: link.id, linkType: link.linkType,
            payload: payload, prevHash: link.prevHash, seqNo: link.seqNo, signature: link.signature,
            signerDeviceID: link.signerDeviceID, signerPubkey: link.signerPubkey,
            timestamp: link.timestamp, userPubkey: link.userPubkey
        )
    }
}
