import XCTest
import Foundation
@testable import Llamenos

/// Pins iOS to the **server-persisted** case-record vectors (#2499).
///
/// `packages/crypto/tests/fixtures/case-record-vectors.json` holds a case
/// summary, case fields and a case comment as the server stored and returned
/// them (`packages/crypto/scripts/gen-case-record-vectors.ts`). The label and
/// AAD each record was sealed under are read out of the fixture, never spelled
/// in Swift, and every assertion has one side that is not `CryptoService`:
///
/// * the server's ciphertext bytes are opened by `CryptoService.openCase` —
///   the production reader — after the fixture reader's content key is
///   re-wrapped to this device under the fixture's declared label and AAD;
/// * what `CryptoService.sealCase` writes is opened by the fixture's readers
///   (loaded as the wake key, a real HPKE opener on the same binary) under the
///   fixture's declared label and AAD;
/// * and the stored-message reading (`LABEL_MESSAGE`, no AAD) — what desktop
///   and Android used before #2499 — opens none of it.
///
/// The fixture's reader secrets cannot be loaded as the *device* key (the FFI
/// has no import), hence the wake key and the re-wrap.
final class CaseRecordVectorTests: XCTestCase {

    // MARK: - Fixture

    private struct Fixture: Decodable {
        struct AAD: Decodable { let content: String; let keyWrap: String }
        struct Reader: Decodable { let name: String; let x25519SecretHex: String; let x25519PubkeyHex: String }
        struct Envelope: Decodable { let pubkey: String; let enc: String; let ct: String }
        struct Record: Decodable {
            let name: String
            let purpose: String
            let label: String
            let aadHex: AAD
            let plaintext: String
            let encryptedContent: String
            let readerEnvelopes: [Envelope]
        }
        let readers: [Reader]
        let records: [Record]
    }

    /// Found from this source file (`#filePath`); a missing fixture fails, never skips.
    private func loadFixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/case-record-vectors.json")
        return try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
    }

    private func purpose(_ rec: Fixture.Record) throws -> CasePurpose {
        switch rec.purpose {
        case "summary": return .summary
        case "fields": return .fields
        case "comment": return .comment
        default:
            XCTFail("unknown purpose \(rec.purpose) in the fixture")
            throw CryptoServiceError.decryptionFailed("unknown purpose")
        }
    }

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

    // MARK: - Helpers

    private func ffiEnvelope(label: String, enc: String, ct: String) throws -> HpkeEnvelope {
        HpkeEnvelope(
            v: 3,
            labelId: try mobileLabelToId(label: label),
            enc: try mobileHexToBase64url(hexStr: enc),
            ct: try mobileHexToBase64url(hexStr: ct)
        )
    }

    /// The content key of `envelope`, opened as `reader` (loaded as the wake key).
    private func contentKey(as reader: Fixture.Reader, label: String, keyWrapAadHex: String, envelope: (enc: String, ct: String)) throws -> String {
        try mobileLoadWakeKey(secretHex: reader.x25519SecretHex)
        return try mobileHpkeOpenWithWakeKey(
            envelope: try ffiEnvelope(label: label, enc: envelope.enc, ct: envelope.ct),
            expectedLabel: label,
            aadHex: keyWrapAadHex
        )
    }

    private func openAsFixtureReader(_ reader: Fixture.Reader, label: String, aad: Fixture.AAD, encryptedContent: String, envelope: (enc: String, ct: String)) throws -> String {
        let keyHex = try contentKey(as: reader, label: label, keyWrapAadHex: aad.keyWrap, envelope: envelope)
        let plaintextHex = try mobileSymmetricDecrypt(ciphertextHex: encryptedContent, keyHex: keyHex, aadHex: aad.content)
        return try XCTUnwrap(String(data: try XCTUnwrap(Self.data(fromHex: plaintextHex)), encoding: .utf8))
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

    // MARK: - The fixture itself

    func testFixtureNamesOneLabelPerPurposeAndTheCanonicalAAD() throws {
        let f = try loadFixture()
        let expected = ["summary": CryptoLabels.LABEL_CASE_SUMMARY, "fields": CryptoLabels.LABEL_CASE_FIELDS, "comment": CryptoLabels.LABEL_CASE_COMMENT]
        XCTAssertEqual(Set(f.records.map(\.purpose)), Set(expected.keys))
        for rec in f.records {
            XCTAssertEqual(rec.label, expected[rec.purpose])
            XCTAssertEqual(rec.aadHex.content, try mobileContentAadHex(label: rec.label))
            XCTAssertEqual(rec.aadHex.keyWrap, try mobileKeyWrapAadHex(label: rec.label))
            XCTAssertEqual(rec.readerEnvelopes.map(\.pubkey), f.readers.map(\.x25519PubkeyHex))
        }
    }

    // MARK: - iOS reads what the server persisted

    func testOpenCaseReadsTheServerPersistedBytes() throws {
        let f = try loadFixture()
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let device = try XCTUnwrap(service.encryptionPubkeyHex)

        for rec in f.records {
            for reader in f.readers {
                let env = try XCTUnwrap(rec.readerEnvelopes.first { $0.pubkey == reader.x25519PubkeyHex })
                let keyHex = try contentKey(as: reader, label: rec.label, keyWrapAadHex: rec.aadHex.keyWrap, envelope: (env.enc, env.ct))
                // Re-wrap the server's content key to this device under the
                // fixture's label and AAD — outside CryptoService.
                let wrap = try mobileHpkeSealKey(keyHex: keyHex, recipientPubkeyHex: device, label: rec.label, aadHex: rec.aadHex.keyWrap)
                let deviceEnvelope = RecipientEnvelope(
                    ct: try mobileBase64urlToHex(b64: wrap.ct),
                    enc: try mobileBase64urlToHex(b64: wrap.enc),
                    pubkey: device
                )
                let opened = try service.openCase(
                    purpose: try purpose(rec),
                    encryptedContent: rec.encryptedContent,
                    envelopes: [deviceEnvelope]
                )
                XCTAssertEqual(opened, rec.plaintext, "openCase could not read the server-persisted \(rec.name) via \(reader.name)'s key")
            }
        }
    }

    // MARK: - iOS writes what every platform reads

    func testSealCaseWritesTheServerPersistedFormat() throws {
        let f = try loadFixture()
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let device = try XCTUnwrap(service.encryptionPubkeyHex)

        for rec in f.records {
            let plaintext = "ios-sealed \(rec.purpose): ¿estás a salvo?"
            let sealed = try service.sealCase(purpose: try purpose(rec), plaintext: plaintext, readerPubkeys: f.readers.map(\.x25519PubkeyHex))
            XCTAssertEqual(sealed.envelopes.map(\.pubkey), [device] + f.readers.map(\.x25519PubkeyHex))
            let fixtureEnvelope = try XCTUnwrap(rec.readerEnvelopes.first)
            for env in sealed.envelopes {
                XCTAssertEqual(env.enc.count, fixtureEnvelope.enc.count)
                XCTAssertEqual(env.ct.count, fixtureEnvelope.ct.count)
            }
            for reader in f.readers {
                let env = try XCTUnwrap(sealed.envelopes.first { $0.pubkey == reader.x25519PubkeyHex })
                let opened = try openAsFixtureReader(reader, label: rec.label, aad: rec.aadHex, encryptedContent: sealed.encryptedContent, envelope: (env.enc, env.ct))
                XCTAssertEqual(opened, plaintext, "\(reader.name) cannot open the \(rec.purpose) iOS sealed")
            }
        }
    }

    // MARK: - The pre-#2499 format is not this one

    func testTheStoredMessageReadingOpensNoneOfIt() throws {
        let f = try loadFixture()
        let reader = try XCTUnwrap(f.readers.first)
        for rec in f.records {
            let env = try XCTUnwrap(rec.readerEnvelopes.first { $0.pubkey == reader.x25519PubkeyHex })
            XCTAssertThrowsError(
                try contentKey(as: reader, label: CryptoLabels.LABEL_MESSAGE, keyWrapAadHex: "", envelope: (env.enc, env.ct)),
                "\(rec.name) opened as a stored message"
            )
        }
    }
}
