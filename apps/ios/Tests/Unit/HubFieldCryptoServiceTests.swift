import Foundation
import Testing
@testable import Llamenos

/// Hub-field sealing runs in Rust under the hub key held in `MobileState`; these
/// tests drive the real `CryptoService` → UniFFI path (no Swift reimplementation
/// exists to compare against). The ciphertext vectors are the desktop
/// `encrypt_hub_field` wire format, also pinned in `packages/crypto`.
struct HubFieldCryptoServiceTests {

    // key = 0x42×32, nonce = 0x07×12, AAD = LABEL_TAG_ENCRYPT.
    private static let hubKeyHex = String(repeating: "42", count: 32)
    private static let asciiVector = "0707070707070707070707072d903ac9db856df12c7b9e44a64e237900b1010e005d"
    private static let unicodeVector = "0707070707070707070707072b9734dadcd11f388a308553bc37a65d51dc8bcad51787b8425520b91510"

    private func makeCrypto(hubId: String) -> CryptoService {
        let crypto = CryptoService()
        crypto.storeHubKeyForTesting(hubId: hubId, keyHex: Self.hubKeyHex)
        return crypto
    }

    @Test func decryptMatchesDesktopVectors() {
        let crypto = makeCrypto(hubId: "hf-vectors")
        #expect(crypto.decryptHubField(
            ciphertextHex: Self.asciiVector, hubId: "hf-vectors", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == "Urgent")
        #expect(crypto.decryptHubField(
            ciphertextHex: Self.unicodeVector, hubId: "hf-vectors", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == "Suivi médical")
    }

    @Test func encryptDecryptRoundTrips() throws {
        let crypto = makeCrypto(hubId: "hf-roundtrip")
        let sealed = try crypto.encryptHubField(
            plaintext: "Test Label", hubId: "hf-roundtrip", label: CryptoLabels.LABEL_TAG_ENCRYPT
        )
        #expect(crypto.decryptHubField(
            ciphertextHex: sealed, hubId: "hf-roundtrip", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == "Test Label")
    }

    @Test func otherLabelDoesNotOpen() throws {
        let crypto = makeCrypto(hubId: "hf-label")
        let sealed = try crypto.encryptHubField(
            plaintext: "secret", hubId: "hf-label", label: CryptoLabels.LABEL_TAG_ENCRYPT
        )
        #expect(crypto.decryptHubField(
            ciphertextHex: sealed, hubId: "hf-label", label: CryptoLabels.LABEL_PLATFORM_ROLE_NAME_ENCRYPT
        ) == nil)
    }

    @Test func unregisteredLabelIsRefused() {
        let crypto = makeCrypto(hubId: "hf-unregistered")
        #expect(throws: (any Error).self) {
            try crypto.encryptHubField(
                plaintext: "x", hubId: "hf-unregistered", label: "llamenos:wrong-label:v1"
            )
        }
    }

    @Test func hubWithoutAKeyCannotSealOrOpen() {
        let crypto = CryptoService()
        #expect(throws: (any Error).self) {
            try crypto.encryptHubField(
                plaintext: "x", hubId: "hf-no-key", label: CryptoLabels.LABEL_TAG_ENCRYPT
            )
        }
        #expect(crypto.decryptHubField(
            ciphertextHex: Self.asciiVector, hubId: "hf-no-key", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == nil)
    }

    @Test func anotherHubsKeyDoesNotOpen() {
        let crypto = CryptoService()
        crypto.storeHubKeyForTesting(hubId: "hf-a", keyHex: Self.hubKeyHex)
        crypto.storeHubKeyForTesting(hubId: "hf-b", keyHex: String(repeating: "ff", count: 32))
        #expect(crypto.decryptHubField(
            ciphertextHex: Self.asciiVector, hubId: "hf-b", label: CryptoLabels.LABEL_TAG_ENCRYPT
        ) == nil)
    }

    @Test func hexStringRoundTrips() {
        let data = Data([0xDE, 0xAD, 0xBE, 0xEF])
        #expect(Data(hexString: "deadbeef") == data)
        #expect(Data(hexString: "abc") == nil)
        #expect(Data(hexString: "zz") == nil)
    }
}
