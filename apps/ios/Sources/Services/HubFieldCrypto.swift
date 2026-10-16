import CryptoKit
import Foundation

// MARK: - HubFieldCrypto

/// Hub-field encryption for small E2EE values stored on the server (tag labels,
/// tag categories, team names). Mirrors the desktop Tauri command
/// `encrypt_hub_field` / `decrypt_hub_field` (apps/desktop/src/crypto.rs):
///
///   AES-256-GCM, key = hub key, AAD = UTF-8(label)
///   wire = hex( nonce_12 || ciphertext || tag_16 )
///
/// The hub key is not a device secret — the Swift layer already holds it for
/// blind-index HMACs (ContactFormViewModel), so sealing here stays inside the
/// same trust boundary. Device private keys are never touched.
///
/// The label must be a domain-separation constant from generated
/// `CryptoLabels` (e.g. `CryptoLabels.LABEL_TAG_ENCRYPT`) — never a raw string.
enum HubFieldCrypto {
    enum HubFieldCryptoError: Error {
        case invalidHex
        case invalidCiphertext
        case sealFailed
    }

    /// Encrypt a UTF-8 field with the hub key. Returns hex(nonce || ct || tag).
    static func encrypt(plaintext: String, label: String, hubKey: Data) throws -> String {
        let key = SymmetricKey(data: hubKey)
        let sealedBox = try AES.GCM.seal(
            Data(plaintext.utf8),
            using: key,
            authenticating: Data(label.utf8)
        )
        guard let combined = sealedBox.combined else {
            // Combined representation is always available for AES-256-GCM boxes
            // produced by `seal`; only thrown for boxes constructed piecemeal.
            throw HubFieldCryptoError.sealFailed
        }
        return combined.map { String(format: "%02x", $0) }.joined()
    }

    /// Decrypt a hub-encrypted field. Returns nil on any failure (bad hex,
    /// wrong key, wrong label, corrupted data) — matching desktop's
    /// `decryptHubField`, which answers null rather than throwing so callers
    /// fall back to displaying the raw stored value.
    static func decrypt(ciphertextHex: String, label: String, hubKey: Data) -> String? {
        guard let data = Data(hexString: ciphertextHex),
              data.count >= 12 + 16 else { return nil }
        let key = SymmetricKey(data: hubKey)
        guard let box = try? AES.GCM.SealedBox(combined: data),
              let plaintext = try? AES.GCM.open(box, using: key, authenticating: Data(label.utf8)) else {
            return nil
        }
        return String(data: plaintext, encoding: .utf8)
    }
}

// MARK: - Data(hexString:)

extension Data {
    /// Parse a hex string (even length, no separators) into bytes.
    /// Returns nil for odd-length or non-hex input.
    init?(hexString: String) {
        let count = hexString.count
        guard count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(count / 2)
        var index = hexString.startIndex
        while index < hexString.endIndex {
            let next = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
