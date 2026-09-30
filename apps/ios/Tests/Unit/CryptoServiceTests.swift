import XCTest
@testable import Llamenos

/// Tests for `CryptoService` against the V3 device-key crypto API
/// (Ed25519 signing + X25519 encryption, HPKE envelope encryption,
/// PIN-encrypted on-device storage). The pre-V3 signing-seed/Schnorr surface
/// no longer exists.
final class CryptoServiceTests: XCTestCase {

    override func setUp() {
        super.setUp()
        // The Rust FFI crypto state is global (per-process). Lock it before each
        // test so that tests starting from a "locked" state are not polluted by
        // a previous test that called generateDeviceKeys().
        CryptoService().lock()
    }

    // MARK: - Device Key Generation

    func testGenerateDeviceKeysProducesPublicKeys() throws {
        let service = CryptoService()
        let encrypted = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        XCTAssertEqual(encrypted.state.signingPubkeyHex.count, 64, "Ed25519 pubkey must be 32 bytes / 64 hex chars")
        XCTAssertEqual(encrypted.state.encryptionPubkeyHex.count, 64, "X25519 pubkey must be 32 bytes / 64 hex chars")
        XCTAssertFalse(encrypted.state.deviceId.isEmpty)
        XCTAssertGreaterThan(encrypted.argon2MCost, 0)
    }

    func testGenerateDeviceKeysSetsServiceState() throws {
        let service = CryptoService()
        XCTAssertFalse(service.isUnlocked)
        XCTAssertNil(service.signingPubkeyHex)

        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        XCTAssertTrue(service.isUnlocked)
        XCTAssertNotNil(service.signingPubkeyHex)
        XCTAssertNotNil(service.encryptionPubkeyHex)
        XCTAssertNotNil(service.pubkey)
    }

    func testGenerateDeviceKeysProducesUniqueKeys() throws {
        let s1 = CryptoService()
        let s2 = CryptoService()
        _ = try s1.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        _ = try s2.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        XCTAssertNotEqual(s1.signingPubkeyHex, s2.signingPubkeyHex)
        XCTAssertNotEqual(s1.encryptionPubkeyHex, s2.encryptionPubkeyHex)
    }

    // MARK: - PIN Validation

    func testInvalidPINIsRejected() {
        let service = CryptoService()
        // Too short (< 8 chars)
        XCTAssertThrowsError(try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345")) { err in
            XCTAssertTrue(err is CryptoServiceError)
        }
        XCTAssertThrowsError(try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "1234567"))
        // 6 letters — too short
        XCTAssertThrowsError(try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "abcdef"))
    }

    func testValidPINFormats() throws {
        let service = CryptoService()
        // 8+ digit PINs are valid
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        service.lock()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "123456789")
        service.lock()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "1234567890")
    }

    // MARK: - Lock / Unlock

    func testLockClearsUnlockedFlag() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        XCTAssertTrue(service.isUnlocked)

        service.lock()
        XCTAssertFalse(service.isUnlocked)
        // Public keys remain for "Locked as ..." UI display
        XCTAssertNotNil(service.signingPubkeyHex)
    }

    func testUnlockWithCorrectPINRoundTrip() throws {
        let service = CryptoService()
        let pin = "65432100"
        let encrypted = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: pin)
        let originalSigning = encrypted.state.signingPubkeyHex
        service.lock()

        let restored = try service.unlockWithPin(data: encrypted, pin: pin)
        XCTAssertEqual(restored.signingPubkeyHex, originalSigning)
        XCTAssertTrue(service.isUnlocked)
    }

    func testUnlockWithWrongPINThrows() throws {
        let service = CryptoService()
        let encrypted = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        service.lock()

        XCTAssertThrowsError(try service.unlockWithPin(data: encrypted, pin: "99999999"))
        XCTAssertFalse(service.isUnlocked)
    }

    // MARK: - Auth Token

    func testAuthTokenCreation() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        let token = try service.createAuthToken(method: "GET", path: "/api/notes")
        XCTAssertEqual(token.pubkey.count, 64)
        XCTAssertFalse(token.token.isEmpty)
        XCTAssertGreaterThan(token.timestamp, 0)
    }

    func testAuthTokenRequiresUnlocked() throws {
        let service = CryptoService()
        XCTAssertThrowsError(try service.createAuthToken(method: "GET", path: "/api/notes"))
    }

    // MARK: - Note Encryption (HPKE)

    func testNoteEncryptionProducesEnvelopePerRecipient() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        let admin1 = CryptoService()
        let admin1Keys = try admin1.generateDeviceKeys(deviceId: UUID().uuidString, pin: "11111111")

        let admin2 = CryptoService()
        let admin2Keys = try admin2.generateDeviceKeys(deviceId: UUID().uuidString, pin: "22222222")

        let recipients = [
            author.encryptionPubkeyHex!,
            admin1Keys.state.encryptionPubkeyHex,
            admin2Keys.state.encryptionPubkeyHex
        ]

        let result = try author.encryptNote(payload: "{\"text\":\"hello\"}", recipientPubkeys: recipients)
        XCTAssertEqual(result.envelopes.count, 3)
        XCTAssertFalse(result.ciphertextHex.isEmpty)
        for env in result.envelopes {
            XCTAssertEqual(env.envelope.v, 3)
            XCTAssertFalse(env.envelope.enc.isEmpty)
            XCTAssertFalse(env.envelope.ct.isEmpty)
        }
    }

    func testNoteEncryptionRequiresUnlocked() throws {
        let service = CryptoService()
        XCTAssertThrowsError(try service.encryptNote(payload: "x", recipientPubkeys: []))
    }

    func testNoteEncryptDecryptRoundTrip() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let payload = "{\"text\":\"sensitive note\"}"

        let result = try author.encryptNote(payload: payload, recipientPubkeys: [author.encryptionPubkeyHex!])
        let envelope = result.envelopes.first!.envelope

        // Read back through the wire pair only — the server stores {enc, ct}, not labelId.
        let decrypted = try author.decryptNote(ciphertextHex: result.ciphertextHex, enc: envelope.enc, ct: envelope.ct)
        XCTAssertEqual(decrypted, payload)
    }

    // MARK: - Wire Envelopes (#1328)
    //
    // The server stores reader envelopes as {pubkey, enc, ct}; labelId is not on the
    // wire, so the reader rebuilds it. #1328: iOS rebuilt every envelope as labelId 0
    // (note-key), so hpke_open's label check rejected every message, hub key and
    // call-record open. These tests exercise the real UniFFI crypto, and assert the
    // plaintext/key comes back — not merely that a call did not throw.

    /// Every generated label ID must equal the labelId Rust stamps on an envelope it
    /// seals with that label. Derived from the real FFI registry, not a second table.
    func testGeneratedLabelIdsMatchRustRegistry() throws {
        let reader = CryptoService()
        _ = try reader.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let recipient = try XCTUnwrap(reader.encryptionPubkeyHex)

        XCTAssertFalse(CryptoLabelIds.byLabel.isEmpty)
        for (label, generatedId) in CryptoLabelIds.byLabel {
            let sealed = try mobileHpkeSeal(plaintextHex: "00", recipientPubkeyHex: recipient, label: label, aadHex: "")
            XCTAssertEqual(sealed.labelId, generatedId, "labelId for \(label)")
        }
    }

    func testWireEnvelopeUsesRegistryIdOfItsLabel() throws {
        XCTAssertEqual(
            try CryptoService.wireEnvelope(enc: "e", ct: "c", label: CryptoLabels.LABEL_MESSAGE).labelId,
            CryptoLabelIds.LABEL_MESSAGE
        )
        XCTAssertEqual(
            try CryptoService.wireEnvelope(enc: "e", ct: "c", label: CryptoLabels.LABEL_CALL_META).labelId,
            CryptoLabelIds.LABEL_CALL_META
        )
        XCTAssertThrowsError(try CryptoService.wireEnvelope(enc: "e", ct: "c", label: "llamenos:not-a-label"))
    }

    /// Author seals a message for itself and a second reader; each reader opens its
    /// own wire envelope and gets the plaintext back.
    func testMessageWireRoundTripForEveryReader() throws {
        let second = CryptoService()
        let secondKeys = try second.generateDeviceKeys(deviceId: UUID().uuidString, pin: "22222222")
        let secondPubkey = secondKeys.state.encryptionPubkeyHex

        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let authorPubkey = try XCTUnwrap(author.encryptionPubkeyHex)
        XCTAssertNotEqual(authorPubkey, secondPubkey)

        let plaintext = "reply from the hotline \(UUID().uuidString)"
        let sealed = try author.encryptMessage(plaintext: plaintext, readerPubkeys: [secondPubkey])
        XCTAssertEqual(Set(sealed.envelopes.map(\.pubkey)), [authorPubkey, secondPubkey])

        let authorEnv = try XCTUnwrap(sealed.envelopes.first { $0.pubkey == authorPubkey })
        XCTAssertEqual(
            try author.decryptMessage(encryptedContent: sealed.encryptedContent, enc: authorEnv.enc, ct: authorEnv.ct),
            plaintext
        )

        // Switch the (process-global) Rust state to the second reader's device key.
        _ = try second.unlockWithPin(data: secondKeys, pin: "22222222")
        let secondEnv = try XCTUnwrap(sealed.envelopes.first { $0.pubkey == secondPubkey })
        XCTAssertEqual(
            try second.decryptMessage(encryptedContent: sealed.encryptedContent, enc: secondEnv.enc, ct: secondEnv.ct),
            plaintext
        )
    }

    /// Label enforcement at decrypt is intact: a message envelope does not open as a
    /// note, and a note envelope does not open as a message.
    func testWireEnvelopeIsRejectedUnderTheWrongLabel() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let me = try XCTUnwrap(service.encryptionPubkeyHex)

        let message = try service.encryptMessage(plaintext: "m", readerPubkeys: [])
        let messageEnv = try XCTUnwrap(message.envelopes.first { $0.pubkey == me })
        XCTAssertThrowsError(
            try service.decryptNote(ciphertextHex: message.encryptedContent, enc: messageEnv.enc, ct: messageEnv.ct)
        )

        let note = try service.encryptNote(payload: "{\"text\":\"n\"}", recipientPubkeys: [me])
        let noteEnv = try XCTUnwrap(note.envelopes.first).envelope
        XCTAssertThrowsError(
            try service.decryptMessage(encryptedContent: note.ciphertextHex, enc: noteEnv.enc, ct: noteEnv.ct)
        )
    }

    /// A hub key wrapped for this device (as the desktop admin client does via
    /// LABEL_HUB_KEY_WRAP) loads into Rust state, and the loaded key is the key that
    /// was wrapped: a draft sealed under that key by the stateless API opens with it.
    func testHubKeyWireEnvelopeLoadsTheWrappedKey() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let me = try XCTUnwrap(service.encryptionPubkeyHex)

        let hubKeyHex = service.randomBytesHex()
        let wrapped = try service.hpkeSealKey(
            keyHex: hubKeyHex, recipientPubkeyHex: me, label: CryptoLabels.LABEL_HUB_KEY_WRAP, aadHex: ""
        )
        let response = try JSONDecoder().decode(
            HubKeyEnvelopeResponse.self,
            from: Data(#"{"envelope":{"pubkey":"\#(me)","enc":"\#(wrapped.enc)","ct":"\#(wrapped.ct)"}}"#.utf8)
        )

        let hubId = "hub-\(UUID().uuidString)"
        XCTAssertFalse(service.hasHubKey(hubId: hubId))
        try service.loadHubKey(hubId: hubId, envelope: response)
        XCTAssertTrue(service.hasHubKey(hubId: hubId))

        let marker = "hub key round trip \(UUID().uuidString)"
        let packed = try encryptDraft(plaintext: marker, secretKeyHex: hubKeyHex)
        XCTAssertEqual(try mobileDecryptDraft(packedHex: packed, hubId: hubId), marker)
    }

    /// A key HPKE-sealed under a different label must not load as a hub key.
    func testHubKeyWrappedUnderAnotherLabelDoesNotLoad() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let me = try XCTUnwrap(service.encryptionPubkeyHex)

        let wrongLabel = try service.hpkeSealKey(
            keyHex: service.randomBytesHex(), recipientPubkeyHex: me, label: CryptoLabels.LABEL_NOTE_KEY, aadHex: ""
        )
        let response = try JSONDecoder().decode(
            HubKeyEnvelopeResponse.self,
            from: Data(#"{"envelope":{"pubkey":"\#(me)","enc":"\#(wrongLabel.enc)","ct":"\#(wrongLabel.ct)"}}"#.utf8)
        )
        let hubId = "hub-\(UUID().uuidString)"
        XCTAssertThrowsError(try service.loadHubKey(hubId: hubId, envelope: response))
        XCTAssertFalse(service.hasHubKey(hubId: hubId))
    }

    // MARK: - Hub Key Cache

    func testHubKeyCacheStartsEmpty() {
        let service = CryptoService()
        XCTAssertFalse(service.hasHubKey(hubId: "any"))
    }

    func testHubKeyCacheStoreAndClear() {
        let service = CryptoService()
        service.storeHubKeyForTesting(hubId: "hub1", keyHex: String(repeating: "a", count: 64))
        XCTAssertTrue(service.hasHubKey(hubId: "hub1"))

        service.clearHubKeys()
        XCTAssertFalse(service.hasHubKey(hubId: "hub1"))
    }

    // MARK: - Sigchain

    func testSigchainLinkCreationRequiresUnlocked() throws {
        let service = CryptoService()
        XCTAssertThrowsError(
            try service.createSigchainLink(
                id: "link1",
                seq: 1,
                prevHash: nil,
                timestamp: "2026-01-01T00:00:00Z",
                payloadJson: "{}"
            )
        )
    }

    func testSigchainLinkSignedByDevice() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        let link = try service.createSigchainLink(
            id: "link1",
            seq: 1,
            prevHash: nil,
            timestamp: "2026-01-01T00:00:00Z",
            payloadJson: "{\"action\":\"author_device\"}"
        )
        XCTAssertEqual(link.signerPubkey, service.signingPubkeyHex)
        XCTAssertFalse(link.signature.isEmpty)
    }

    // MARK: - Ephemeral Keypair (Device Linking)

    func testEphemeralKeypairProducesDistinctSecretAndPublic() {
        let service = CryptoService()
        let kp = service.generateEphemeralKeypair()
        XCTAssertEqual(kp.secretHex.count, 64)
        XCTAssertEqual(kp.publicHex.count, 64)
        XCTAssertNotEqual(kp.secretHex, kp.publicHex)
    }

    func testEphemeralKeypairsAreUnique() {
        let service = CryptoService()
        let a = service.generateEphemeralKeypair()
        let b = service.generateEphemeralKeypair()
        XCTAssertNotEqual(a.secretHex, b.secretHex)
        XCTAssertNotEqual(a.publicHex, b.publicHex)
    }
}
