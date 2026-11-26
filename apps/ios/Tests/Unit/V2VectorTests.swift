import XCTest
@testable import Llamenos

/// The crate's v2 vectors (`packages/crypto/tests/fixtures/v2/`, spec D15),
/// opened through this app's production readers — the UniFFI calls
/// `CryptoService` makes.
///
/// - `hpke-wrap.json` (D1, D2): the recipient is unlocked as this device through
///   `mobileUnlock` from the PIN blob the vectors carry (there is no raw-secret
///   import, by design); every shape opens and every negative fails with its code.
/// - `server-event.json` (D9, #2999): the keys a member of hub A holds open hub A's
///   frames and nothing else; a frame moved between hubs, kinds or epochs does not.
final class V2VectorTests: XCTestCase {

    private struct Envelope: Decodable {
        let enc: String
        let ct: String
        var ffi: HpkeEnvelope { HpkeEnvelope(enc: enc, ct: ct) }
    }

    private struct WrapFixture: Decodable {
        struct Positive: Decodable { let shape: String; let aadFields: [String]; let plaintextHex: String; let envelope: Envelope }
        struct Negative: Decodable { let name: String; let shape: String; let aadFields: [String]; let envelope: Envelope; let expect: String }
        struct DeviceKeys: Decodable { let pin: String; let blob: EncryptedDeviceKeys }
        let recipientPubkeyHex: String
        let recipientDeviceKeys: DeviceKeys
        let positives: [Positive]
        let negatives: [Negative]
    }

    private struct EventFixture: Decodable {
        struct Key: Decodable { let hubId: String; let epoch: UInt64; let keyHex: String }
        struct Frame: Decodable { let name: String; let hubId: String; let kind: UInt32; let epoch: UInt64; let plaintext: String; let payload: String }
        struct Negative: Decodable { let name: String; let hubId: String; let kind: UInt32; let epoch: UInt64; let payload: String; let expect: String }
        let heldKeys: [Key]
        let frames: [Frame]
        let negatives: [Negative]
    }

    private func load<T: Decodable>(_ name: String) throws -> T {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/v2/\(name)")
        return try JSONDecoder().decode(T.self, from: try Data(contentsOf: url))
    }

    /// The crate's serde name (`note-key`) → the UniFFI enum case.
    private func shape(_ name: String) throws -> Shape {
        let all: [Shape] = [
            .noteKey, .fileKey, .fileMetadataKey, .contactProfileKey, .contactIdKey, .hubKey,
            .firehoseWindowKey, .messageKey, .callMetaKey, .pukSeed, .auditUserKey, .pushWake,
            .pushFull, .platformRoleName, .platformRoleDescription, .recoveryGroupShare,
            .recoveryShareContribution, .recoveryPukSeed,
        ]
        // The UniFFI raw value IS the C-ABI byte, which the vectors list in order.
        let names = [
            "note-key", "file-key", "file-metadata-key", "contact-profile-key", "contact-id-key", "hub-key",
            "firehose-window-key", "message-key", "call-meta-key", "puk-seed", "audit-user-key", "push-wake",
            "push-full", "platform-role-name", "platform-role-description", "recovery-group-share",
            "recovery-share-contribution", "recovery-puk-seed",
        ]
        guard let i = names.firstIndex(of: name) else { throw CryptoServiceError.decryptionFailed("unknown shape \(name)") }
        XCTAssertEqual(all[i].rawValue, UInt8(i))
        return all[i]
    }

    override func tearDown() {
        mobileClearServerEventKeys()
        CryptoService().lock()
        super.tearDown()
    }

    func testEveryShapeOpensThroughTheDeviceKeyAndEveryNegativeFailsWithItsCode() throws {
        let f: WrapFixture = try load("hpke-wrap.json")
        let state = try mobileUnlock(data: f.recipientDeviceKeys.blob, pin: f.recipientDeviceKeys.pin)
        XCTAssertEqual(state.encryptionPubkeyHex, f.recipientPubkeyHex)
        XCTAssertEqual(f.positives.count, 18, "a shape has no vector")
        for p in f.positives {
            XCTAssertEqual(try mobileShapeOpen(shape: try shape(p.shape), aadFields: p.aadFields, envelope: p.envelope.ffi), p.plaintextHex, p.shape)
        }
        for n in f.negatives {
            let s = try shape(n.shape)
            XCTAssertEqual(codeOfFailure { _ = try mobileShapeOpen(shape: s, aadFields: n.aadFields, envelope: n.envelope.ffi) }, n.expect, n.name)
        }
    }

    func testAMemberOfHubAOpensHubAsFramesAndEveryNegativeFailsWithItsCode() throws {
        let f: EventFixture = try load("server-event.json")
        try CryptoService().setServerEventKeys(f.heldKeys.map { ServerEventKey(hubId: $0.hubId, epoch: $0.epoch, keyHex: $0.keyHex) })
        let held = Set(f.heldKeys.map(\.hubId))
        var opened = 0
        for frame in f.frames {
            let open = { try mobileOpenServerEvent(hubId: frame.hubId, kind: frame.kind, epoch: frame.epoch, payloadHex: frame.payload) }
            if held.contains(frame.hubId) {
                XCTAssertEqual(try open(), frame.plaintext, frame.name)
                opened += 1
            } else {
                XCTAssertEqual(codeOfFailure { _ = try open() }, "no_event_key", frame.name)
            }
        }
        XCTAssertEqual(opened, 3)
        for n in f.negatives {
            XCTAssertEqual(
                codeOfFailure { _ = try mobileOpenServerEvent(hubId: n.hubId, kind: n.kind, epoch: n.epoch, payloadHex: n.payload) },
                n.expect,
                n.name
            )
        }
    }
}
