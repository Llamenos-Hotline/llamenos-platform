import XCTest
import Foundation
@testable import Llamenos

/// A case summary must be sealed to the readers the server names for the
/// `summary` tier, not to its author and an admin only (#1682).
///
/// "The record was created" passes with every reader missing, which is how the
/// defect survived. So these tests assert on the envelope set a record would be
/// STORED with and then OPEN it with real HPKE as each member, using the
/// reader secrets of the server-persisted fixture
/// (`packages/crypto/tests/fixtures/case-record-vectors.json`, loaded as the
/// wake key — a real opener on the same binary). Label and AAD are read from the
/// fixture, never spelled in Swift. The "server" tiers are decoded from the JSON
/// `GET /api/records/envelope-recipients` returns.
final class RecordReadersTests: XCTestCase {

    // MARK: - Fixture

    private struct Fixture: Decodable {
        struct AAD: Decodable { let content: String; let keyWrap: String }
        struct Reader: Decodable { let name: String; let x25519SecretHex: String; let x25519PubkeyHex: String }
        struct Record: Decodable { let purpose: String; let label: String; let aadHex: AAD }
        let readers: [Reader]
        let records: [Record]
    }

    private func loadFixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/case-record-vectors.json")
        return try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
    }

    /// `volunteer` is the member the server puts on the tier; `admin` is the instance admin key.
    private struct World {
        let volunteer: Fixture.Reader
        let admin: Fixture.Reader
        let summaryRecord: Fixture.Record
        let service: CryptoService
        var device: String { service.encryptionPubkeyHex ?? "" }
    }

    private func world() throws -> World {
        let f = try loadFixture()
        let service = CryptoService()
        _ = try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        return World(
            volunteer: try XCTUnwrap(f.readers.first { $0.name == "volunteer" }),
            admin: try XCTUnwrap(f.readers.first { $0.name == "admin" }),
            summaryRecord: try XCTUnwrap(f.records.first { $0.purpose == "summary" }),
            service: service
        )
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

    /// The JSON the endpoint answers with.
    private func tiers(summary: [String], fields: [String], pii: [String] = []) throws -> EnvelopeRecipientsResponse {
        let json: [String: [String]] = ["summary": summary, "fields": fields, "pii": pii]
        return try JSONDecoder().decode(EnvelopeRecipientsResponse.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// Open the sealed summary as the holder of `secretHex`, or throw when no
    /// envelope in the set opens for them.
    private func open(
        _ sealed: (encryptedContent: String, envelopes: [RecipientEnvelope]),
        secretHex: String,
        pubkey: String?,
        record: Fixture.Record
    ) throws -> String {
        try mobileLoadWakeKey(secretHex: secretHex)
        // Without a pubkey the holder is not addressed by anything; try every envelope.
        let candidates = sealed.envelopes.filter { pubkey == nil || $0.pubkey == pubkey }
        var lastError: Error = CryptoServiceError.decryptionFailed("no envelope addressed to this key")
        for env in candidates {
            do {
                let keyHex = try mobileHpkeOpenWithWakeKey(
                    envelope: HpkeEnvelope(
                        v: 3,
                        labelId: try mobileLabelToId(label: record.label),
                        enc: try mobileHexToBase64url(hexStr: env.enc),
                        ct: try mobileHexToBase64url(hexStr: env.ct)
                    ),
                    expectedLabel: record.label,
                    aadHex: record.aadHex.keyWrap
                )
                let plaintextHex = try mobileSymmetricDecrypt(ciphertextHex: sealed.encryptedContent, keyHex: keyHex, aadHex: record.aadHex.content)
                let bytes = stride(from: 0, to: plaintextHex.count, by: 2).map { i -> UInt8 in
                    let s = plaintextHex.index(plaintextHex.startIndex, offsetBy: i)
                    return UInt8(plaintextHex[s..<plaintextHex.index(s, offsetBy: 2)], radix: 16)!
                }
                return String(decoding: bytes, as: UTF8.self)
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    private func sealSummary(_ w: World, readers: [String]) throws -> (encryptedContent: String, envelopes: [RecipientEnvelope]) {
        try w.service.sealCase(purpose: .summary, plaintext: "{\"title\":\"Welfare check\"}", readerPubkeys: readers)
    }

    // MARK: - The stored envelope set

    func testStoredSummaryNamesTheServersReadersAsWellAsAuthorAndAdmin() async throws {
        let w = try world()
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminDecryptionPubkey: w.admin.x25519PubkeyHex
        ) { try self.tiers(summary: [w.volunteer.x25519PubkeyHex], fields: []) }

        XCTAssertEqual(readers.summary, [w.device, w.volunteer.x25519PubkeyHex, w.admin.x25519PubkeyHex])
        let sealed = try sealSummary(w, readers: readers.summary)
        XCTAssertEqual(Set(sealed.envelopes.map(\.pubkey)), Set([w.device, w.volunteer.x25519PubkeyHex, w.admin.x25519PubkeyHex]))
    }

    func testTheServerNamedReaderCanActuallyDecryptWhatWasStored() async throws {
        let w = try world()
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminDecryptionPubkey: w.admin.x25519PubkeyHex
        ) { try self.tiers(summary: [w.volunteer.x25519PubkeyHex], fields: []) }
        let sealed = try sealSummary(w, readers: readers.summary)

        for member in [w.volunteer, w.admin] {
            let opened = try open(sealed, secretHex: member.x25519SecretHex, pubkey: member.x25519PubkeyHex, record: w.summaryRecord)
            XCTAssertEqual(opened, "{\"title\":\"Welfare check\"}", "\(member.name) cannot open the stored summary")
        }
    }

    func testAMemberTheServerDidNotNameCannotDecrypt() async throws {
        let w = try world()
        // The server names nobody beyond the admin; the volunteer is NOT a reader.
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminDecryptionPubkey: w.admin.x25519PubkeyHex
        ) { try self.tiers(summary: [], fields: []) }
        let sealed = try sealSummary(w, readers: readers.summary)

        XCTAssertFalse(sealed.envelopes.map(\.pubkey).contains(w.volunteer.x25519PubkeyHex))
        // No envelope is addressed to them, and their key opens none of the others.
        XCTAssertThrowsError(try open(sealed, secretHex: w.volunteer.x25519SecretHex, pubkey: nil, record: w.summaryRecord))
    }

    // MARK: - Failed lookup

    func testAFailedLookupStillSealsToAuthorAndAdminAndNamesNoOtherKey() async throws {
        struct Offline: Error {}
        let w = try world()
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminDecryptionPubkey: w.admin.x25519PubkeyHex
        ) { throw Offline() }

        XCTAssertEqual(readers.summary, [w.device, w.admin.x25519PubkeyHex])
        let sealed = try sealSummary(w, readers: readers.summary)
        XCTAssertEqual(Set(sealed.envelopes.map(\.pubkey)), Set([w.device, w.admin.x25519PubkeyHex]))
        XCTAssertEqual(
            try open(sealed, secretHex: w.admin.x25519SecretHex, pubkey: w.admin.x25519PubkeyHex, record: w.summaryRecord),
            "{\"title\":\"Welfare check\"}"
        )
    }

    // MARK: - No admin reader

    func testNoAdminRecipientRefusesTheWriteWithoutAskingTheServer() async throws {
        let w = try world()
        for bad in [nil, "", "not-hex", String(repeating: "ab", count: 16), String(repeating: "g", count: 64)] {
            var asked = false
            do {
                _ = try await RecordReaderSet.creationReaders(author: w.device, adminDecryptionPubkey: bad) {
                    asked = true
                    return try self.tiers(summary: [], fields: [])
                }
                XCTFail("an envelope set with no admin reader was produced for admin key \(String(describing: bad))")
            } catch {
                XCTAssertEqual(error as? RecordReadersError, .noAdminReader)
            }
            XCTAssertFalse(asked, "asked the server before refusing for \(String(describing: bad))")
        }
    }

    // MARK: - Composition

    func testTiersStayDistinctAndDropMalformedServerEntries() throws {
        let a = String(repeating: "a1", count: 32), b = String(repeating: "b2", count: 32)
        let admin = String(repeating: "c3", count: 32), author = String(repeating: "d4", count: 32)
        let readers = try RecordReaderSet.compose(
            serverTiers: try tiers(summary: [a, b, "garbage"], fields: [b, b, author], pii: [a]),
            author: author, adminDecryptionPubkey: admin
        )
        XCTAssertEqual(readers.summary, [author, a, b, admin])
        XCTAssertEqual(readers.fields, [author, b, admin])      // the summary-only member `a` is not here
        XCTAssertEqual(readers.pii, [author, a, admin])
    }
}
