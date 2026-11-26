import Foundation
@testable import Llamenos

/// Unlock `service` as a reader of a format-1 conformance fixture, through the
/// production `mobileUnlock`.
///
/// The FFI deliberately has no raw-secret import, so the crate's seeded vector
/// generator emits each fixture reader as a PIN-encrypted device-key blob
/// (`packages/crypto/tests/fixtures/v2/fixture-reader-devices.json`). Opening a
/// fixture as that device is then exactly what the app does with its own device.
func unlockAsFixtureReader(_ service: CryptoService, x25519PubkeyHex: String) throws {
    struct Devices: Decodable {
        let pin: String
        let devices: [String: EncryptedDeviceKeys]
    }
    var dir = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
    let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/v2/fixture-reader-devices.json")
    let f = try JSONDecoder().decode(Devices.self, from: try Data(contentsOf: url))
    guard let blob = f.devices[x25519PubkeyHex] else {
        throw CryptoServiceError.decryptionFailed("no fixture device for \(x25519PubkeyHex)")
    }
    _ = try service.unlockWithPin(data: blob, pin: f.pin)
}
