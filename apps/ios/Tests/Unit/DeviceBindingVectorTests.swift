import XCTest
@testable import Llamenos

/// `packages/crypto/tests/fixtures/v2/device-binding.json` (#2496; spec
/// 2026-11-25-v2-device-linking-and-recovery §5–§6) through this app's
/// production reader: `CryptoService.verifySigchains` over UniFFI — each chain
/// verified, then cross-user key reuse refused. Positives yield the crate's
/// active device keys exactly (the genesis names the first device's X-Wing key);
/// each negative fails with its closed rejection code.
final class DeviceBindingVectorTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Key: Decodable { let devicePubkey: String; let encryptionPubkey: String }
        struct Positive: Decodable { let name: String; let chains: JSONValue; let expect: [[Key]] }
        struct Negative: Decodable { let name: String; let chains: JSONValue; let expect: String }
        let positives: [Positive]
        let negatives: [Negative]
    }

    /// The chains, re-serialised verbatim for the crate.
    private struct JSONValue: Decodable {
        let json: String
        init(from decoder: Decoder) throws {
            let any = try JSONAny(from: decoder)
            json = String(decoding: try JSONEncoder().encode(any), as: UTF8.self)
        }
    }

    private func load() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/v2/device-binding.json")
        return try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
    }

    func testPositivesYieldTheCratesActiveDeviceKeys() throws {
        let f = try load()
        XCTAssertEqual(f.positives.count, 3)
        for p in f.positives {
            let states = try CryptoService().verifySigchains(chainsJson: p.chains.json)
            XCTAssertEqual(
                states.map { $0.activeDeviceKeys.map { "\($0.devicePubkey):\($0.encryptionPubkey)" } },
                p.expect.map { $0.map { "\($0.devicePubkey):\($0.encryptionPubkey)" } },
                p.name
            )
        }
    }

    func testNegativesFailWithTheirCode() throws {
        let f = try load()
        XCTAssertEqual(f.negatives.count, 9)
        for n in f.negatives {
            XCTAssertEqual(
                codeOfFailure { _ = try CryptoService().verifySigchains(chainsJson: n.chains.json) },
                n.expect,
                n.name
            )
        }
    }

    /// The device's own genesis, built in Rust, names the X-Wing key it holds;
    /// unlocking again reads the same key and never draws one.
    func testTheGenesisNamesTheDevicesOwnXWingKey() throws {
        let service = CryptoService()
        let pin = "65432100"
        let encrypted = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        XCTAssertEqual(encrypted.state.kemPubkeyHex.count, 2432)
        let genesis = try service.createSigchainLink(
            id: "g", seq: 1, prevHash: nil, timestamp: "2026-11-26T00:00:00Z",
            payloadJson: try service.userInitPayload()
        )
        let verified = try service.verifySigchain(linksJson: try linksJson([genesis]))
        XCTAssertEqual(verified.activeDeviceKeys.map(\.encryptionPubkey), [encrypted.state.kemPubkeyHex])
        service.lock()
        XCTAssertEqual(try service.unlockWithPin(data: encrypted, pin: pin).kemPubkeyHex, encrypted.state.kemPubkeyHex)
    }
}

/// UniFFI `SigchainLink`s in the crate's JSON shape.
func linksJson(_ links: [SigchainLink]) throws -> String {
    let array: [[String: Any]] = links.map { l in
        [
            "id": l.id, "seq": l.seq, "prevHash": l.prevHash ?? NSNull(), "entryHash": l.entryHash,
            "signerDeviceId": l.signerDeviceId, "signerPubkey": l.signerPubkey,
            "signature": l.signature, "timestamp": l.timestamp, "payloadJson": l.payloadJson,
        ]
    }
    return String(decoding: try JSONSerialization.data(withJSONObject: array), as: UTF8.self)
}
