import XCTest
@testable import Llamenos

/// `packages/crypto/tests/fixtures/v2/device-binding.json` (#2496; spec
/// 2026-11-25-v2-device-linking-and-recovery §5–§6) through this app's
/// production reader: `CryptoService.genesisDeviceSet` over UniFFI — the device
/// set a hub's migration genesis is built from. Positives produce the crate's
/// set exactly; each negative fails with its closed rejection code.
final class DeviceBindingVectorTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Device: Decodable { let devicePubkey: String; let kemPubkey: String? }
        struct Expect: Decodable { let included: [Device]; let missing: [Device] }
        struct Positive: Decodable { let name: String; let chains: JSONValue; let expect: Expect }
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

    func testPositivesProduceTheCratesGenesisDeviceSet() throws {
        let f = try load()
        XCTAssertEqual(f.positives.count, 3)
        for p in f.positives {
            let set = try CryptoService().genesisDeviceSet(chainsJson: p.chains.json)
            XCTAssertEqual(set.included.map(\.kemPubkey), p.expect.included.compactMap(\.kemPubkey), p.name)
            XCTAssertEqual(set.missing.map(\.devicePubkey), p.expect.missing.map(\.devicePubkey), p.name)
        }
    }

    func testNegativesFailWithTheirCode() throws {
        let f = try load()
        XCTAssertEqual(f.negatives.count, 8)
        for n in f.negatives {
            XCTAssertEqual(
                codeOfFailure { _ = try CryptoService().genesisDeviceSet(chainsJson: n.chains.json) },
                n.expect,
                n.name
            )
        }
    }

    /// A pilot device's 64-byte blob (the fixture readers are pilot-shaped) gains
    /// an X-Wing key on unlock, and keeps its signing and X25519 keys.
    func testAPilotBlobGainsAnXWingKeyOnUnlock() throws {
        struct Devices: Decodable { let pin: String; let devices: [String: EncryptedDeviceKeys] }
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }
        let f = try JSONDecoder().decode(Devices.self, from: try Data(contentsOf: dir.appendingPathComponent(
            "packages/crypto/tests/fixtures/v2/fixture-reader-devices.json")))
        let pilot = try XCTUnwrap(f.devices.values.first)
        XCTAssertNil(pilot.state.kemPubkeyHex)
        let pilotService = CryptoService()
        let upgraded = try XCTUnwrap(try pilotService.unlockWithPin(data: pilot, pin: f.pin).upgradedKeys)
        XCTAssertEqual(upgraded.state.signingPubkeyHex, pilot.state.signingPubkeyHex)
        XCTAssertEqual(upgraded.state.encryptionPubkeyHex, pilot.state.encryptionPubkeyHex)
        XCTAssertEqual(upgraded.state.kemPubkeyHex?.count, 2432)
        // The stored form round-trips the new key through the app's Codable.
        let decoded = try JSONDecoder().decode(EncryptedDeviceKeys.self, from: try JSONEncoder().encode(upgraded))
        XCTAssertEqual(decoded.state.kemPubkeyHex, upgraded.state.kemPubkeyHex)
        pilotService.lock()

        let service = CryptoService()
        let encrypted = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "65432100")
        XCTAssertNotNil(encrypted.state.kemPubkeyHex, "a new device has an X-Wing key")
        service.lock()
        let unlocked = try service.unlockWithPin(data: encrypted, pin: "65432100")
        XCTAssertNil(unlocked.upgradedKeys, "a device that has one is not re-keyed")
        XCTAssertEqual(service.kemPubkeyHex, encrypted.state.kemPubkeyHex)
    }
}
