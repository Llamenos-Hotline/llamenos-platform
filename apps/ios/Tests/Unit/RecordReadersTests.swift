import XCTest
import Foundation
@testable import Llamenos

/// A case summary must be sealed to the readers the server names for the
/// `summary` tier, not to its author and an admin only (#1682).
///
/// "The record was created" passes with every reader missing, which is how the
/// defect survived. So these tests assert on the envelope set a record would be
/// STORED with and then OPEN it as each member through the production reader
/// (`openCase`), each member being a real device this test generated and
/// unlocks again through `mobileUnlock`. Nothing here names a label or an AAD:
/// the crate's case module does (spec D1). The "server" tiers are decoded from
/// the JSON `GET /api/records/envelope-recipients` returns.
final class RecordReadersTests: XCTestCase {

    private static let pin = "12345678"

    /// A device a member holds: its X25519 key and the PIN blob that unlocks it.
    private struct Member {
        let name: String
        let blob: EncryptedDeviceKeys
        var x25519PubkeyHex: String { blob.state.encryptionPubkeyHex }
    }

    /// `volunteer` is the member the server puts on the tier; `admin` and
    /// `secondAdmin` are hub admins; `service` is loaded as the author.
    private struct World {
        let volunteer: Member
        let admin: Member
        let secondAdmin: Member
        let author: Member
        let service: CryptoService
        var device: String { author.x25519PubkeyHex }
    }

    private func member(_ name: String, _ service: CryptoService) throws -> Member {
        Member(name: name, blob: try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: Self.pin))
    }

    private func world() throws -> World {
        let service = CryptoService()
        let volunteer = try member("volunteer", service)
        let admin = try member("admin", service)
        let secondAdmin = try member("second admin", service)
        let author = try member("author", service)   // generated last: loaded now
        return World(volunteer: volunteer, admin: admin, secondAdmin: secondAdmin, author: author, service: service)
    }

    override func setUp() {
        super.setUp()
        CryptoService().lock()
    }

    override func tearDown() {
        CryptoService().lock()
        super.tearDown()
    }

    /// The JSON the endpoint answers with.
    private func tiers(summary: [String], fields: [String], pii: [String] = []) throws -> EnvelopeRecipientsResponse {
        let json: [String: [String]] = ["summary": summary, "fields": fields, "pii": pii]
        return try JSONDecoder().decode(EnvelopeRecipientsResponse.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// Open the sealed summary as `member`'s device, through the production reader.
    private func open(_ sealed: (encryptedContent: String, envelopes: [RecipientEnvelope]), as member: Member, _ w: World) throws -> String {
        _ = try w.service.unlockWithPin(data: member.blob, pin: Self.pin)
        return try w.service.openCase(purpose: .summary, encryptedContent: sealed.encryptedContent, envelopes: sealed.envelopes)
    }

    private func sealSummary(_ w: World, readers: [String]) throws -> (encryptedContent: String, envelopes: [RecipientEnvelope]) {
        try w.service.sealCase(purpose: .summary, plaintext: "{\"title\":\"Welfare check\"}", readerPubkeys: readers)
    }

    // MARK: - The stored envelope set

    func testStoredSummaryNamesTheServersReadersAsWellAsAuthorAndAdmin() async throws {
        let w = try world()
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminReaders: { [w.admin.x25519PubkeyHex] }
        ) { try self.tiers(summary: [w.volunteer.x25519PubkeyHex], fields: []) }

        XCTAssertEqual(readers.summary, [w.device, w.volunteer.x25519PubkeyHex, w.admin.x25519PubkeyHex])
        let sealed = try sealSummary(w, readers: readers.summary)
        XCTAssertEqual(Set(sealed.envelopes.map(\.pubkey)), Set([w.device, w.volunteer.x25519PubkeyHex, w.admin.x25519PubkeyHex]))
    }

    func testTheServerNamedReaderCanActuallyDecryptWhatWasStored() async throws {
        let w = try world()
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminReaders: { [w.admin.x25519PubkeyHex] }
        ) { try self.tiers(summary: [w.volunteer.x25519PubkeyHex], fields: []) }
        let sealed = try sealSummary(w, readers: readers.summary)

        for member in [w.volunteer, w.admin] {
            let opened = try open(sealed, as: member, w)
            XCTAssertEqual(opened, "{\"title\":\"Welfare check\"}", "\(member.name) cannot open the stored summary")
        }
    }

    func testAMemberTheServerDidNotNameCannotDecrypt() async throws {
        let w = try world()
        // The server names nobody beyond the admin; the volunteer is NOT a reader.
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminReaders: { [w.admin.x25519PubkeyHex] }
        ) { try self.tiers(summary: [], fields: []) }
        let sealed = try sealSummary(w, readers: readers.summary)

        XCTAssertFalse(sealed.envelopes.map(\.pubkey).contains(w.volunteer.x25519PubkeyHex))
        // No envelope is addressed to them, and their key opens none of the others.
        XCTAssertThrowsError(try open(sealed, as: w.volunteer, w))
    }

    // MARK: - Failed lookup

    func testAFailedLookupStillSealsToAuthorAndAdminAndNamesNoOtherKey() async throws {
        struct Offline: Error {}
        let w = try world()
        let readers = try await RecordReaderSet.creationReaders(
            author: w.device, adminReaders: { [w.admin.x25519PubkeyHex] }
        ) { throw Offline() }

        XCTAssertEqual(readers.summary, [w.device, w.admin.x25519PubkeyHex])
        let sealed = try sealSummary(w, readers: readers.summary)
        XCTAssertEqual(Set(sealed.envelopes.map(\.pubkey)), Set([w.device, w.admin.x25519PubkeyHex]))
        XCTAssertEqual(
            try open(sealed, as: w.admin, w),
            "{\"title\":\"Welfare check\"}"
        )
    }

    // MARK: - No admin reader

    func testNoAdminReaderRefusesTheWriteWithoutAskingTheServer() async throws {
        let w = try world()
        var asked = false
        do {
            _ = try await RecordReaderSet.creationReaders(author: w.device, adminReaders: { [] }) {
                asked = true
                return try self.tiers(summary: [], fields: [])
            }
            XCTFail("an envelope set with no admin reader was produced")
        } catch {
            XCTAssertEqual(error as? RecordReadersError, .noAdminReader)
        }
        XCTAssertFalse(asked, "asked the server before refusing")
    }

    /// The crate decides which server entries are readers (#1035); a set with nothing
    /// usable is a refusal, never a write sealed to the author alone.
    func testAHubWhoseReaderSetHoldsNoUsableKeyIsRefused() throws {
        for unusable in [[], [""], ["not-hex"], [String(repeating: "ab", count: 16)], [String(repeating: "g", count: 64)]] {
            XCTAssertThrowsError(try HubAdminReaders.admins(from: unusable), "readers \(unusable)") {
                XCTAssertEqual($0 as? RecordReadersError, .noAdminReader)
            }
        }
    }

    /// #1035: a second admin is a reader too — the scalar `adminDecryptionPubkey` held one.
    func testEveryAdminOfTheHubCanOpenWhatWasStored() async throws {
        let w = try world()
        let second = w.secondAdmin
        let admins = try HubAdminReaders.admins(
            from: [w.admin.x25519PubkeyHex.uppercased(), second.x25519PubkeyHex, w.admin.x25519PubkeyHex]
        )
        XCTAssertEqual(admins, [w.admin.x25519PubkeyHex, second.x25519PubkeyHex], "normalised, deduplicated, in server order")

        let readers = try await RecordReaderSet.creationReaders(author: w.device, adminReaders: { admins }) {
            try self.tiers(summary: [], fields: [])
        }
        let sealed = try sealSummary(w, readers: readers.summary)
        for admin in [w.admin, second] {
            XCTAssertEqual(
                try open(sealed, as: admin, w),
                "{\"title\":\"Welfare check\"}",
                "\(admin.name) cannot open what the hub's admins must be able to read"
            )
        }
    }

    // MARK: - Composition

    func testTiersStayDistinctAndDropMalformedServerEntries() throws {
        let a = String(repeating: "a1", count: 32), b = String(repeating: "b2", count: 32)
        let admin = String(repeating: "c3", count: 32), author = String(repeating: "d4", count: 32)
        let readers = try RecordReaderSet.compose(
            serverTiers: try tiers(summary: [a, b, "garbage"], fields: [b, b, author], pii: [a]),
            author: author, adminReaders: [admin]
        )
        XCTAssertEqual(readers.summary, [author, a, b, admin])
        XCTAssertEqual(readers.fields, [author, b, admin])      // the summary-only member `a` is not here
        XCTAssertEqual(readers.pii, [author, a, admin])
    }
}
