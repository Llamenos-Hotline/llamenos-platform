import XCTest
@testable import Llamenos

/// The device backup through this app's production path (#3053): `CryptoService`
/// over UniFFI into `packages/crypto/src/backup.rs` (v6).
///
/// 1. Round trip: data sealed to the device BEFORE the backup — a note sealed to
///    its X25519 key — opens on the restored device, and the restored device's
///    X-Wing key is the one its genesis named. The crate derives that key from
///    the restored seed and unlocking re-checks it, so equality proves the seed
///    came back; the crate's own test decapsulates an X-Wing ciphertext with it.
/// 2. Refusal: a backup without the X-Wing seed — the committed v5 vector and a
///    v6 file relabelled v5 — is refused as `BackupMissingXwingSeed`, naming the
///    missing seed, and loads nothing.
final class DeviceBackupTests: XCTestCase {

    private let pin = "13572468"
    private let newPin = "86427531"

    func testARestoredDeviceOpensWhatWasSealedToItBeforeTheBackup() throws {
        let original = CryptoService()
        let blob = try original.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        let note = try original.encryptNote(
            payload: #"{"text":"sealed before the backup"}"#, recipientPubkeys: [blob.state.encryptionPubkeyHex]
        )
        let genesis = try original.createSigchainLink(
            id: "g", seq: 1, prevHash: nil, timestamp: "2026-11-26T00:00:00Z",
            payloadJson: try original.userInitPayload()
        )
        let chainNamed = try XCTUnwrap(
            try original.verifySigchain(linksJson: try linksJson([genesis])).activeDeviceKeys.first?.encryptionPubkey
        )
        XCTAssertEqual(chainNamed, blob.state.kemPubkeyHex)

        let recoveryKey = original.generateRecoveryKey()
        let backup = try original.createBackup(pin: pin, recoveryKey: recoveryKey)
        original.lock()

        let restored = CryptoService()
        let restoredBlob = try restored.restoreBackup(
            backupJson: backup, credential: recoveryKey, isRecoveryKey: true, newPin: newPin, deviceId: UUID().uuidString
        )
        let envelope = try XCTUnwrap(note.envelopes.first?.envelope)
        XCTAssertTrue(try restored.decryptNote(ciphertextHex: note.ciphertextHex, envelope: envelope)
            .contains("sealed before the backup"))
        XCTAssertEqual(restoredBlob.state.kemPubkeyHex, chainNamed)
        XCTAssertEqual(restored.kemPubkeyHex, chainNamed)
        restored.lock()
        XCTAssertEqual(try restored.unlockWithPin(data: restoredBlob, pin: newPin).kemPubkeyHex, chainNamed)
    }

    func testABackupWithoutTheXWingSeedIsRefusedByName() throws {
        let original = CryptoService()
        _ = try original.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        let recoveryKey = original.generateRecoveryKey()
        var v6 = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(try original.createBackup(pin: pin, recoveryKey: recoveryKey).utf8))
                as? [String: Any]
        )
        original.lock()
        v6["v"] = 5
        let relabelled = String(decoding: try JSONSerialization.data(withJSONObject: v6), as: UTF8.self)

        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let committed = try XCTUnwrap(JSONSerialization.jsonObject(with: try Data(contentsOf: dir.appendingPathComponent(
            "packages/crypto/tests/fixtures/backup-v5-without-xwing-seed.json"))) as? [String: Any])
        let committedFile = String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(committed["backup"])), as: UTF8.self)
        let committedKey = try XCTUnwrap(committed["recoveryKey"] as? String)

        for (name, file, credential) in [("relabelled v6", relabelled, recoveryKey), ("committed v5", committedFile, committedKey)] {
            let restored = CryptoService()
            XCTAssertThrowsError(try restored.restoreBackup(
                backupJson: file, credential: credential, isRecoveryKey: true, newPin: newPin, deviceId: "r"
            ), name) { error in
                XCTAssertEqual(cryptoErrorCode(error), "backup_missing_xwing_seed", name)
                XCTAssertTrue(String(describing: error).contains("X-Wing seed"), "\(name): \(error)")
            }
            XCTAssertFalse(restored.isUnlocked, "\(name): a refused backup loads nothing")
        }
    }
}
