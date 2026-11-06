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

        let decrypted = try author.decryptNote(ciphertextHex: result.ciphertextHex, envelope: envelope)
        XCTAssertEqual(decrypted, payload)
    }

    // MARK: - Case records + case comments (sealed per purpose — #1025, #2499)
    //
    // `sealCase` / `openCase` take a purpose and no label: the crate decides
    // the label and AAD. The old tests here passed `LABEL_MESSAGE` /
    // `LABEL_NOTE_KEY` to the opener to prove it refused them; that input no
    // longer exists, so the equivalent property is that no purpose opens
    // another purpose's ciphertext. The cross-platform half — that these bytes
    // are the server-persisted format — is `CaseRecordVectorTests`.

    func testCaseCiphertextRoundTripsForEveryPurpose() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let payload = "{\"title\":\"Case A\",\"description\":\"details\"}"

        for purpose in [CasePurpose.summary, .fields, .comment] {
            // The caller's own device gets an envelope even when readerPubkeys is empty
            let result = try author.sealCase(purpose: purpose, plaintext: payload, readerPubkeys: [])
            XCTAssertEqual(result.envelopes.map(\.pubkey), [try XCTUnwrap(author.encryptionPubkeyHex)])
            let decrypted = try author.openCase(purpose: purpose, encryptedContent: result.encryptedContent, envelopes: result.envelopes)
            XCTAssertEqual(decrypted, payload)
        }
    }

    func testCaseWireEnvelopesAreHex() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        let result = try author.sealCase(purpose: .summary, plaintext: "{\"title\":\"t\"}", readerPubkeys: [])

        for env in result.envelopes {
            XCTAssertEqual(env.enc.count, 64, "wire enc must be 32-byte hex, not base64url")
            XCTAssertEqual(env.ct.count, 96, "wire ct must be 48-byte hex")
            XCTAssertTrue(env.enc.allSatisfy(\.isHexDigit), "wire enc must be valid hex")
            XCTAssertTrue(env.ct.allSatisfy(\.isHexDigit), "wire ct must be valid hex")
        }
    }

    func testCasePurposesDoNotCrossOpen() throws {
        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        let purposes: [CasePurpose] = [.summary, .fields, .comment]
        for sealedAs in purposes {
            let sealed = try author.sealCase(purpose: sealedAs, plaintext: "{\"title\":\"t\"}", readerPubkeys: [])
            for openedAs in purposes where openedAs != sealedAs {
                XCTAssertThrowsError(
                    try author.openCase(purpose: openedAs, encryptedContent: sealed.encryptedContent, envelopes: sealed.envelopes),
                    "\(sealedAs) opened as \(openedAs)"
                )
            }
        }
    }

    func testCaseCiphertextSealedForAnotherReaderIsNotOpenableByUs() throws {
        // Seal to a different device first — the Rust crypto state is global,
        // so `other` must seal before `author` replaces the loaded device key.
        let other = CryptoService()
        _ = try other.generateDeviceKeys(deviceId: UUID().uuidString, pin: "11111111")
        let result = try other.sealCase(purpose: .summary, plaintext: "{\"title\":\"t\"}", readerPubkeys: [])

        let author = CryptoService()
        _ = try author.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")

        XCTAssertThrowsError(try author.openCase(purpose: .summary, encryptedContent: result.encryptedContent, envelopes: result.envelopes))
    }

    func testCaseOperationsRequireUnlocked() {
        let service = CryptoService()
        service.lock()
        XCTAssertThrowsError(try service.sealCase(purpose: .summary, plaintext: "x", readerPubkeys: []))
        XCTAssertThrowsError(try service.openCase(purpose: .summary, encryptedContent: "aa", envelopes: []))
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
