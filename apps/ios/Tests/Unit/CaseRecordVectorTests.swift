import XCTest
import Foundation
@testable import Llamenos

/// Pins iOS to the **server-persisted** case-record vectors (#2499).
///
/// `packages/crypto/tests/fixtures/case-record-vectors.json` holds a case
/// summary, case fields and a case comment as the server stored and returned
/// them (`packages/crypto/scripts/gen-case-record-vectors.ts`). Each fixture
/// reader is unlocked as this device through `mobileUnlock`, from the PIN blob
/// the crate emits for it (`v2/fixture-reader-devices.json`), and every open
/// goes through the production reader:
///
/// * the server's ciphertext bytes are opened by `CryptoService.openCase` as
///   each of their readers;
/// * what `CryptoService.sealCase` writes is opened by each fixture reader's
///   device in turn;
/// * and the stored-message reading (`decryptMessage`) — what desktop and
///   Android used before #2499 — opens none of it.
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
    }

    override func tearDown() {
        CryptoService().lock()
        super.tearDown()
    }

    // MARK: - Helpers

    private static func hex(_ text: String) -> String {
        Data(text.utf8).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - The fixture itself

    func testFixtureNamesOneLabelPerPurposeAndTheCanonicalAAD() throws {
        let f = try loadFixture()
        let expected = ["summary": CryptoLabels.LABEL_CASE_SUMMARY, "fields": CryptoLabels.LABEL_CASE_FIELDS, "comment": CryptoLabels.LABEL_CASE_COMMENT]
        XCTAssertEqual(Set(f.records.map(\.purpose)), Set(expected.keys))
        for rec in f.records {
            XCTAssertEqual(rec.label, expected[rec.purpose])
            // The format-1 case AADs (crate `case_record.rs`), as the fixture declares them.
            XCTAssertEqual(rec.aadHex.content, Self.hex(rec.label))
            XCTAssertEqual(rec.aadHex.keyWrap, Self.hex("\(rec.label):key-wrap"))
            XCTAssertEqual(rec.readerEnvelopes.map(\.pubkey), f.readers.map(\.x25519PubkeyHex))
        }
    }

    // MARK: - iOS reads what the server persisted

    func testOpenCaseReadsTheServerPersistedBytes() throws {
        let f = try loadFixture()
        let service = CryptoService()
        for rec in f.records {
            for reader in f.readers {
                try unlockAsFixtureReader(service, x25519PubkeyHex: reader.x25519PubkeyHex)
                let opened = try service.openCase(
                    purpose: try purpose(rec),
                    encryptedContent: rec.encryptedContent,
                    envelopes: rec.readerEnvelopes.map { RecipientEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey) }
                )
                XCTAssertEqual(opened, rec.plaintext, "openCase could not read the server-persisted \(rec.name) as \(reader.name)")
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
                let readerService = CryptoService()
                try unlockAsFixtureReader(readerService, x25519PubkeyHex: reader.x25519PubkeyHex)
                let opened = try readerService.openCase(purpose: try purpose(rec), encryptedContent: sealed.encryptedContent, envelopes: sealed.envelopes)
                XCTAssertEqual(opened, plaintext, "\(reader.name) cannot open the \(rec.purpose) iOS sealed")
            }
        }
    }

    // MARK: - The pre-#2499 format is not this one

    func testTheStoredMessageReadingOpensNoneOfIt() throws {
        let f = try loadFixture()
        let reader = try XCTUnwrap(f.readers.first)
        let service = CryptoService()
        try unlockAsFixtureReader(service, x25519PubkeyHex: reader.x25519PubkeyHex)
        for rec in f.records {
            XCTAssertThrowsError(
                try service.decryptMessage(
                    encryptedContent: rec.encryptedContent,
                    readerEnvelopes: rec.readerEnvelopes.map { RecipientEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey) }
                ),
                "\(rec.name) opened as a stored message"
            )
        }
    }
}
