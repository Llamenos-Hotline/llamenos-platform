import Foundation
import Testing
@testable import Llamenos

struct CryptoServiceHubKeyTests {

    @Test func storeHubKeyMakesItAvailable() throws {
        let crypto = CryptoService()
        crypto.storeHubKeyForTesting(hubId: "hub-001", keyHex: String(repeating: "ab", count: 32))
        #expect(crypto.hasHubKey(hubId: "hub-001") == true)
        #expect(crypto.hasHubKey(hubId: "hub-002") == false)
        crypto.clearHubKeys()
    }

    @Test func clearHubKeysEvictsAllKeys() throws {
        let crypto = CryptoService()
        crypto.storeHubKeyForTesting(hubId: "hub-001", keyHex: String(repeating: "ab", count: 32))
        crypto.storeHubKeyForTesting(hubId: "hub-002", keyHex: String(repeating: "cd", count: 32))
        #expect(crypto.hasHubKey(hubId: "hub-001") == true)
        #expect(crypto.hasHubKey(hubId: "hub-002") == true)
        crypto.clearHubKeys()
        #expect(crypto.hasHubKey(hubId: "hub-001") == false)
        #expect(crypto.hasHubKey(hubId: "hub-002") == false)
    }

    @Test func hasHubKeyReturnsFalseForUnknownHub() {
        let crypto = CryptoService()
        #expect(crypto.hasHubKey(hubId: "hub-001") == false)
    }

    @Test func lockClearsHubKeys() {
        let crypto = CryptoService()
        crypto.storeHubKeyForTesting(hubId: "hub-001", keyHex: String(repeating: "ab", count: 32))
        crypto.lock()
        #expect(crypto.hasHubKey(hubId: "hub-001") == false)
    }

    /// Relay-event keys are per hub (#2999) and live in Rust; a hub this user
    /// holds no key for opens nothing.
    @Test func serverEventKeysArePerHub() throws {
        let crypto = CryptoService()
        try crypto.setServerEventKeys([
            ServerEventKey(hubId: "hub-a", epoch: 20000, keyHex: String(repeating: "11", count: 32)),
        ])
        #expect(crypto.openServerEvent(hubId: "hub-b", kind: 1000, epoch: 20000, payloadHex: String(repeating: "00", count: 540)) == nil)
        crypto.lock()
    }

    @Test func aMalformedEventKeyListIsRefusedWhole() {
        let crypto = CryptoService()
        #expect(codeOfFailure {
            try crypto.setServerEventKeys([
                ServerEventKey(hubId: "Hub_A", epoch: 1, keyHex: String(repeating: "11", count: 32)),
            ])
        } == "invalid_id")
    }
}

/// The hub-key envelope, exercised through the production loader.
///
/// The hub-key shape fixes the label and AAD in Rust (spec D1), the same call
/// Android makes, so these cases prove the shape binds (another shape's wrap does
/// not open as a hub key) and that the one encoding is enforced (D2: base64url and
/// uppercase are refused, never normalised — the #1649 verification cases).
struct CryptoServiceHubKeyAadTests {

    private func unlockedService() throws -> (CryptoService, String) {
        let crypto = CryptoService()
        crypto.lock()
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        guard let pubkey = crypto.encryptionPubkeyHex else {
            throw CryptoServiceError.noKeyLoaded
        }
        return (crypto, pubkey)
    }

    private func response(enc: String, ct: String, pubkey: String) -> HubKeyEnvelopeResponse {
        HubKeyEnvelopeResponse(envelope: SharedAdminEnvelope(ct: ct, enc: enc, pubkey: pubkey))
    }

    private func base64url(_ hex: String) -> String {
        let bytes = Data(hexString: hex) ?? Data()
        return bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The hub-key shape round-trips through `loadHubKey`.
    @Test func hubKeyShapeRoundTrips() throws {
        let (crypto, pubkey) = try unlockedService()
        defer { crypto.lock() }
        let sealed = try crypto.shapeSeal(shape: .hubKey, recipientPubkeyHex: pubkey, plaintextHex: String(repeating: "7a", count: 32))
        try crypto.loadHubKey(hubId: "hub-shape", envelope: response(enc: sealed.enc, ct: sealed.ct, pubkey: pubkey))
        #expect(crypto.hasHubKey(hubId: "hub-shape") == true)
    }

    /// The shape binds: a wrap sealed as another shape does not open as a hub key.
    @Test func anotherShapesWrapDoesNotOpenAsAHubKey() throws {
        let (crypto, pubkey) = try unlockedService()
        defer { crypto.lock() }
        let sealed = try crypto.shapeSeal(shape: .noteKey, recipientPubkeyHex: pubkey, plaintextHex: String(repeating: "7a", count: 32))
        #expect(codeOfFailure {
            try crypto.loadHubKey(hubId: "hub-other-shape", envelope: response(enc: sealed.enc, ct: sealed.ct, pubkey: pubkey))
        } == "decryption_failed")
        #expect(crypto.hasHubKey(hubId: "hub-other-shape") == false)
    }

    /// D2: base64url and uppercase hex are refused as `invalid_format`.
    @Test func base64urlAndUppercaseAreRefused() throws {
        let (crypto, pubkey) = try unlockedService()
        defer { crypto.lock() }
        let sealed = try crypto.shapeSeal(shape: .hubKey, recipientPubkeyHex: pubkey, plaintextHex: String(repeating: "7a", count: 32))
        for (enc, ct) in [
            (base64url(sealed.enc), base64url(sealed.ct)),
            (sealed.enc, base64url(sealed.ct)),
            (sealed.enc.uppercased(), sealed.ct),
            (sealed.enc, sealed.ct.uppercased()),
        ] {
            #expect(codeOfFailure {
                try crypto.loadHubKey(hubId: "hub-d2", envelope: response(enc: enc, ct: ct, pubkey: pubkey))
            } == "invalid_format")
        }
        #expect(crypto.hasHubKey(hubId: "hub-d2") == false)
    }
}
