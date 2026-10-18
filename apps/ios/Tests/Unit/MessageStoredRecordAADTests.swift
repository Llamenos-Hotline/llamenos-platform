import XCTest
import Foundation
@testable import Llamenos

/// Pins iOS to the **server's** stored-record convention for `LABEL_MESSAGE`
/// (#1927): NO AAD on the AES-256-GCM content layer and NO AAD on the HPKE key
/// wrap, label bound as the HPKE `info` (PROTOCOL.md §2.4).
///
/// The source of truth is `packages/crypto/tests/fixtures/stored-record-vectors.json`
/// (added by #1928). It is written by the server's own `encryptMessageForStorage`,
/// not by this client, and the very AAD these tests use is read out of the
/// fixture's `aadHex` block rather than spelled in Swift. A test that only
/// round-tripped iOS against itself would pass whatever AAD iOS chose, which is
/// how the defect hid in the first place — so every assertion here has one side
/// that is NOT `CryptoService`:
///
/// * the fixture's server bytes are opened with the fixture's declared AAD;
/// * what `CryptoService.encryptMessage` seals is opened by the fixture's
///   readers, through a different key path (the wake key), under the fixture's AAD;
/// * what is sealed under the fixture's AAD, outside `CryptoService`, must be
///   opened by `CryptoService.decryptMessage`;
/// * and the canonical `label` / `label:key-wrap` AAD — the old iOS shape — must
///   be refused in both directions.
///
/// The fixture's reader secrets cannot be loaded as the *device* key (the FFI has
/// no import; Rust's own tests poke the state directly), so the fixture's readers
/// are loaded as the wake key, which is a real HPKE opener on the same binary.
final class MessageStoredRecordAADTests: XCTestCase {

    // MARK: - Fixture

    private struct Fixture: Decodable {
        struct AAD: Decodable { let content: String; let keyWrap: String }
        struct Reader: Decodable { let name: String; let x25519SecretHex: String; let x25519PubkeyHex: String }
        struct Envelope: Decodable { let pubkey: String; let enc: String; let ct: String }
        struct Record: Decodable {
            let name: String
            let label: String
            let plaintext: String
            let encryptedContent: String
            let readerEnvelopes: [Envelope]
        }
        let aadHex: AAD
        let readers: [Reader]
        let records: [Record]
    }

    /// `packages/crypto/tests/fixtures/stored-record-vectors.json`, found from this
    /// source file (`#filePath` is the only reliable anchor — the simulator's cwd
    /// is not the repo). A missing fixture fails the test; it never skips.
    private func loadFixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/stored-record-vectors.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private func messageRecord(_ f: Fixture) throws -> Fixture.Record {
        try XCTUnwrap(f.records.first { $0.label == CryptoLabels.LABEL_MESSAGE },
                      "the fixture has no \(CryptoLabels.LABEL_MESSAGE) record")
    }

    // MARK: - Helpers

    override func setUp() {
        super.setUp()
        CryptoService().lock()
        mobileClearWakeKey()
    }

    override func tearDown() {
        mobileClearWakeKey()
        CryptoService().lock()
        super.tearDown()
    }

    private func canonicalContentAad() throws -> String { try mobileContentAadHex(label: CryptoLabels.LABEL_MESSAGE) }
    private func canonicalKeyWrapAad() throws -> String { try mobileKeyWrapAadHex(label: CryptoLabels.LABEL_MESSAGE) }

    private func ffiEnvelope(enc: String, ct: String) throws -> HpkeEnvelope {
        HpkeEnvelope(
            v: 3,
            labelId: try mobileLabelToId(label: CryptoLabels.LABEL_MESSAGE),
            enc: try mobileHexToBase64url(hexStr: enc),
            ct: try mobileHexToBase64url(hexStr: ct)
        )
    }

    /// Open `envelope` as `reader` (fixture reader loaded as the wake key), then
    /// the content layer, each under the caller-chosen AAD.
    private func openAsFixtureReader(
        _ reader: Fixture.Reader,
        encryptedContent: String,
        envelope: (enc: String, ct: String),
        keyWrapAadHex: String,
        contentAadHex: String
    ) throws -> String {
        try mobileLoadWakeKey(secretHex: reader.x25519SecretHex)
        let keyHex = try mobileHpkeOpenWithWakeKey(
            envelope: try ffiEnvelope(enc: envelope.enc, ct: envelope.ct),
            expectedLabel: CryptoLabels.LABEL_MESSAGE,
            aadHex: keyWrapAadHex
        )
        let plaintextHex = try mobileSymmetricDecrypt(ciphertextHex: encryptedContent, keyHex: keyHex, aadHex: contentAadHex)
        let bytes = try XCTUnwrap(Self.data(fromHex: plaintextHex))
        return try XCTUnwrap(String(data: bytes, encoding: .utf8))
    }

    private static func data(fromHex hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }

    private static func hex(_ string: String) -> String {
        string.utf8.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - The fixture itself

    func testFixtureDeclaresTheStoredRecordAADAsEmpty() throws {
        let f = try loadFixture()
        XCTAssertEqual(f.aadHex.content, "", "PROTOCOL.md §2.4: the content layer of a stored record carries no AAD")
        XCTAssertEqual(f.aadHex.keyWrap, "", "PROTOCOL.md §2.4: the key wrap of a stored record carries no AAD")
        XCTAssertFalse(f.readers.isEmpty)
    }

    /// The server's bytes open on the binary iOS links, under the fixture's AAD,
    /// and refuse the canonical one. If this fails the fixture or the xcframework
    /// moved, and every test below is measuring against the wrong thing.
    func testServerWrittenMessageOpensUnderTheFixtureAADAndNotTheCanonicalOne() throws {
        let f = try loadFixture()
        let rec = try messageRecord(f)
        for reader in f.readers {
            let env = try XCTUnwrap(rec.readerEnvelopes.first { $0.pubkey == reader.x25519PubkeyHex })
            let opened = try openAsFixtureReader(
                reader, encryptedContent: rec.encryptedContent, envelope: (env.enc, env.ct),
                keyWrapAadHex: f.aadHex.keyWrap, contentAadHex: f.aadHex.content
            )
            XCTAssertEqual(opened, rec.plaintext, "\(reader.name) cannot open the server's message")

            XCTAssertThrowsError(try openAsFixtureReader(
                reader, encryptedContent: rec.encryptedContent, envelope: (env.enc, env.ct),
                keyWrapAadHex: try canonicalKeyWrapAad(), contentAadHex: try canonicalContentAad()
            ), "\(reader.name) opened the server's message under the canonical AAD")
        }
    }

    // MARK: - iOS writes what the server reads

    /// `CryptoService.encryptMessage` -> the fixture's readers, who are not iOS
    /// device keys, under the AAD the fixture declares. Fails if iOS ever binds
    /// an AAD to either layer again.
    func testIOSSealedMessageIsReadableByTheServersConvention() throws {
        let f = try loadFixture()
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let plaintext = "volunteer: estoy aquí, I'm listening"

        let sealed = try service.encryptMessage(
            plaintext: plaintext,
            readerPubkeys: f.readers.map(\.x25519PubkeyHex)
        )

        // One envelope per reader plus this device, addressed by pubkey.
        let expected = Set(f.readers.map(\.x25519PubkeyHex) + [try XCTUnwrap(service.encryptionPubkeyHex)])
        XCTAssertEqual(Set(sealed.envelopes.map(\.pubkey)), expected)

        // Same wire shape the server writes: hex enc (32 B) and hex ct (48 B).
        let fixtureEnvelope = try XCTUnwrap(messageRecord(f).readerEnvelopes.first)
        for env in sealed.envelopes {
            XCTAssertEqual(env.enc.count, fixtureEnvelope.enc.count)
            XCTAssertEqual(env.ct.count, fixtureEnvelope.ct.count)
        }

        for reader in f.readers {
            let env = try XCTUnwrap(sealed.envelopes.first { $0.pubkey == reader.x25519PubkeyHex })
            let opened = try openAsFixtureReader(
                reader, encryptedContent: sealed.encryptedContent, envelope: (env.enc, env.ct),
                keyWrapAadHex: f.aadHex.keyWrap, contentAadHex: f.aadHex.content
            )
            XCTAssertEqual(opened, plaintext, "\(reader.name) cannot open what iOS sealed")

            // …and not under the canonical AAD, on either layer.
            let canonicalWrap = try canonicalKeyWrapAad()
            let canonicalContent = try canonicalContentAad()
            for (wrap, content) in [(canonicalWrap, canonicalContent), (canonicalWrap, f.aadHex.content), (f.aadHex.keyWrap, canonicalContent)] {
                XCTAssertThrowsError(try openAsFixtureReader(
                    reader, encryptedContent: sealed.encryptedContent, envelope: (env.enc, env.ct),
                    keyWrapAadHex: wrap, contentAadHex: content
                ), "iOS-sealed message opened with an AAD on a layer — iOS has re-introduced an AAD")
            }
        }
    }

    /// The same record, read back by iOS's own decrypt path.
    func testIOSSealedMessageRoundTripsThroughDecryptMessage() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let sealed = try service.encryptMessage(plaintext: "round trip", readerPubkeys: [])
        XCTAssertEqual(
            try service.decryptMessage(encryptedContent: sealed.encryptedContent, readerEnvelopes: sealed.envelopes),
            "round trip"
        )
    }

    // MARK: - iOS reads what the server writes

    /// A stored record sealed under the fixture's declared AAD, by code that is
    /// not `CryptoService`, addressed to this device. `decryptMessage` must open it.
    func testIOSDecryptsARecordSealedUnderTheFixtureAAD() throws {
        let f = try loadFixture()
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let devicePubkey = try XCTUnwrap(service.encryptionPubkeyHex)
        let plaintext = "caller: are you there? necesito ayuda"

        let sealed = try sealByHand(
            plaintext: plaintext, recipient: devicePubkey,
            keyWrapAadHex: f.aadHex.keyWrap, contentAadHex: f.aadHex.content
        )
        XCTAssertEqual(
            try service.decryptMessage(encryptedContent: sealed.encryptedContent, readerEnvelopes: [sealed.envelope]),
            plaintext
        )
    }

    /// The old iOS shape — canonical AAD on both layers — is what the server and
    /// desktop can never have written; `decryptMessage` must refuse it rather than
    /// quietly keep a second convention alive.
    func testIOSRefusesARecordSealedUnderTheCanonicalAAD() throws {
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let devicePubkey = try XCTUnwrap(service.encryptionPubkeyHex)

        let sealed = try sealByHand(
            plaintext: "sealed the pre-fix iOS way", recipient: devicePubkey,
            keyWrapAadHex: try canonicalKeyWrapAad(), contentAadHex: try canonicalContentAad()
        )
        XCTAssertThrowsError(
            try service.decryptMessage(encryptedContent: sealed.encryptedContent, readerEnvelopes: [sealed.envelope])
        )
    }

    private func sealByHand(
        plaintext: String,
        recipient: String,
        keyWrapAadHex: String,
        contentAadHex: String
    ) throws -> (encryptedContent: String, envelope: RecipientEnvelope) {
        let out = try mobileSymmetricEncrypt(plaintextHex: Self.hex(plaintext), aadHex: contentAadHex)
        let sealedKey = try mobileHpkeSealKey(
            keyHex: out[1], recipientPubkeyHex: recipient,
            label: CryptoLabels.LABEL_MESSAGE, aadHex: keyWrapAadHex
        )
        let envelope = RecipientEnvelope(
            ct: try mobileBase64urlToHex(b64: sealedKey.ct),
            enc: try mobileBase64urlToHex(b64: sealedKey.enc),
            pubkey: recipient
        )
        return (out[0], envelope)
    }
}
