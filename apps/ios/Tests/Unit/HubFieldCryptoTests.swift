import Foundation
import Testing
@testable import Llamenos

struct HubFieldCryptoTests {

    // Fixed test vector: key=0x42*32, nonce=0x07*12, AAD="llamenos:tag-field:v1".
    // Generated from Rust aes-gcm using the same construction as the desktop
    // encrypt_hub_field — proves cross-platform wire compatibility.
    private static let hubKey = Data(repeating: 0x42, count: 32)

    @Test func decryptMatchesRustVector() throws {
        let ciphertext = "0707070707070707070707072d903ac9db856df12c7b9e44a64e237900b1010e005d"
        let plaintext = try HubFieldCrypto.decrypt(
            ciphertextHex: ciphertext,
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: Self.hubKey
        )
        #expect(plaintext == "Urgent")
    }

    @Test func decryptMatchesRustVectorUnicode() throws {
        let ciphertext = "0707070707070707070707072b9734dadcd11f388a308553bc37a65d51dc8bcad51787b8425520b91510"
        let plaintext = try HubFieldCrypto.decrypt(
            ciphertextHex: ciphertext,
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: Self.hubKey
        )
        #expect(plaintext == "Suivi médical")
    }

    @Test func encryptDecryptRoundTrips() throws {
        let original = "Test Label"
        let encrypted = try HubFieldCrypto.encrypt(
            plaintext: original,
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: Self.hubKey
        )
        let decrypted = try HubFieldCrypto.decrypt(
            ciphertextHex: encrypted,
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: Self.hubKey
        )
        #expect(decrypted == original)
    }

    @Test func wrongLabelFailsDecryption() throws {
        let encrypted = try HubFieldCrypto.encrypt(
            plaintext: "secret",
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: Self.hubKey
        )
        #expect(throws: (any Error).self) {
            try HubFieldCrypto.decrypt(
                ciphertextHex: encrypted,
                label: "llamenos:wrong-label:v1",
                hubKey: Self.hubKey
            )
        }
    }

    @Test func wrongKeyFailsDecryption() throws {
        let encrypted = try HubFieldCrypto.encrypt(
            plaintext: "secret",
            label: CryptoLabels.LABEL_TAG_ENCRYPT,
            hubKey: Self.hubKey
        )
        let wrongKey = Data(repeating: 0xFF, count: 32)
        #expect(throws: (any Error).self) {
            try HubFieldCrypto.decrypt(
                ciphertextHex: encrypted,
                label: CryptoLabels.LABEL_TAG_ENCRYPT,
                hubKey: wrongKey
            )
        }
    }

    @Test func hexStringRoundTrips() {
        let data = Data([0xDE, 0xAD, 0xBE, 0xEF])
        let hex = data.map { String(format: "%02x", $0) }.joined()
        #expect(hex == "deadbeef")
        #expect(Data(hexString: hex) == data)
    }
}
