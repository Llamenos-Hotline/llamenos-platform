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

    @Test func storeServerEventKeyStoresAsHubKey() {
        let crypto = CryptoService()
        let keyHex = String(repeating: "ef", count: 32)
        crypto.storeServerEventKey(hubId: "hub-svr", keyHex: keyHex)
        #expect(crypto.hasHubKey(hubId: "hub-svr") == true)
        crypto.clearHubKeys()
    }

    @Test func setServerEventKeysStoresInRust() throws {
        let crypto = CryptoService()
        let currentKey = String(repeating: "11", count: 32)
        try crypto.setServerEventKeys(currentHex: currentKey)
        // Server event keys are separate from hub keys — no hub key assertion
        // The key is stored in Rust for mobile_decrypt_server_event
        crypto.lock()
    }

    @Test func decryptHubEventReturnsNilForUnknownHub() {
        let crypto = CryptoService()
        let result = crypto.decryptHubEvent(ciphertextHex: String(repeating: "00", count: 40), hubId: "no-such-hub")
        #expect(result == nil)
    }

    @Test func decryptEventWithAttributionReturnsNilWhenEmpty() {
        let crypto = CryptoService()
        let result = crypto.decryptEventWithAttribution(ciphertextHex: String(repeating: "00", count: 40))
        #expect(result == nil)
    }
}

/// The hub-key envelope's AAD, exercised rather than asserted about.
///
/// `docs/protocol/PROTOCOL.md` §2.7 binds `UTF-8("llamenos:hub-key-wrap:key-wrap")`
/// to both the seal and the open. iOS passed an empty AAD until #1631 — as did
/// the desktop and Android, so the three agreed with each other and with
/// neither the spec nor the Rust crate's own `hpke_wrap_key`. These cases are
/// written so that reverting the fix fails them: one proves the composite AAD
/// round-trips, one proves an empty-AAD wrap no longer opens, and one proves
/// the AAD is binding rather than merely passed.
struct CryptoServiceHubKeyAadTests {

    /// A wrap sealed by the caller, converted to the hex wire form
    /// `loadHubKey` consumes (`toFfiEnvelope` maps hex -> base64url again).
    private func wireEnvelope(
        _ crypto: CryptoService,
        hubKeyHex: String,
        recipientPubkeyHex: String,
        label: String,
        aadHex: String
    ) throws -> HubKeyEnvelopeResponse {
        let sealed = try crypto.hpkeSealKey(
            keyHex: hubKeyHex,
            recipientPubkeyHex: recipientPubkeyHex,
            label: label,
            aadHex: aadHex
        )
        return HubKeyEnvelopeResponse(
            envelope: SharedAdminEnvelope(
                ct: try mobileBase64urlToHex(b64: sealed.ct),
                enc: try mobileBase64urlToHex(b64: sealed.enc),
                pubkey: recipientPubkeyHex
            )
        )
    }

    private func unlockedService() throws -> (CryptoService, String) {
        let crypto = CryptoService()
        crypto.lock()
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        guard let pubkey = crypto.encryptionPubkeyHex else {
            throw CryptoServiceError.noKeyLoaded
        }
        return (crypto, pubkey)
    }

    /// Case 1 — wrap and unwrap under the composite AAD succeeds.
    @Test func compositeAadRoundTrips() throws {
        let (crypto, pubkey) = try unlockedService()
        defer { crypto.lock() }
        let envelope = try wireEnvelope(
            crypto,
            hubKeyHex: String(repeating: "7a", count: 32),
            recipientPubkeyHex: pubkey,
            label: CryptoLabels.LABEL_HUB_KEY_WRAP,
            aadHex: try mobileKeyWrapAadHex(label: CryptoLabels.LABEL_HUB_KEY_WRAP)
        )
        try crypto.loadHubKey(hubId: "hub-aad-composite", envelope: envelope)
        #expect(crypto.hasHubKey(hubId: "hub-aad-composite") == true)
    }

    /// Case 2 — the wire break. A wrap sealed with an EMPTY AAD, which is what
    /// every pre-#1631 client wrote, must no longer open. Pre-production, so
    /// invalidating those envelopes is the fix, not a regression.
    @Test func emptyAadWrapNoLongerOpens() throws {
        let (crypto, pubkey) = try unlockedService()
        defer { crypto.lock() }
        let envelope = try wireEnvelope(
            crypto,
            hubKeyHex: String(repeating: "7a", count: 32),
            recipientPubkeyHex: pubkey,
            label: CryptoLabels.LABEL_HUB_KEY_WRAP,
            aadHex: ""
        )
        #expect(throws: (any Error).self) {
            try crypto.loadHubKey(hubId: "hub-aad-empty", envelope: envelope)
        }
        #expect(crypto.hasHubKey(hubId: "hub-aad-empty") == false)
    }

    /// Case 3 — the AAD is binding, not decorative: a wrap sealed under a
    /// *different* label's composite AAD does not open as a hub key, even
    /// though the bytes are a perfectly well-formed key-wrap AAD.
    @Test func anotherLabelsCompositeAadDoesNotOpen() throws {
        let (crypto, pubkey) = try unlockedService()
        defer { crypto.lock() }
        let envelope = try wireEnvelope(
            crypto,
            hubKeyHex: String(repeating: "7a", count: 32),
            recipientPubkeyHex: pubkey,
            label: CryptoLabels.LABEL_HUB_KEY_WRAP,
            aadHex: try mobileKeyWrapAadHex(label: CryptoLabels.LABEL_NOTE_KEY)
        )
        #expect(throws: (any Error).self) {
            try crypto.loadHubKey(hubId: "hub-aad-wrong-label", envelope: envelope)
        }
        #expect(crypto.hasHubKey(hubId: "hub-aad-wrong-label") == false)
    }

    /// Case 4 — the AAD bytes iOS binds are the bytes PROTOCOL.md §2.7 names.
    /// The desktop derives the same string from `@shared/envelope-aad` and
    /// Android from the same Rust function, so a divergence here is the one
    /// cross-language failure this envelope can still have.
    @Test func aadBytesMatchTheProtocolSpelling() throws {
        let expected = Data("llamenos:hub-key-wrap:key-wrap".utf8)
            .map { String(format: "%02x", $0) }
            .joined()
        #expect(try mobileKeyWrapAadHex(label: CryptoLabels.LABEL_HUB_KEY_WRAP) == expected)
    }
}
