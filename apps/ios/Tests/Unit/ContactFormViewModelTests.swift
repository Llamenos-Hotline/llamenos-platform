import Foundation
import XCTest
@testable import Llamenos

/// What a contact create or edit puts on the wire, and who can open it (#2792).
///
/// Until #2792 both forms refused to save: they read the hub key from a store nothing ever
/// filled (`HubKeyStore.currentHubKey`), took the `error_no_hub_key` branch every time, and
/// no test noticed because none ever saved a contact. These tests save one, against a hub
/// whose key is NOT held, and then OPEN the stored ciphertext as a second reader — a device
/// this test generated and unlocks through the production `mobileUnlock`, the way another
/// admin's phone would. A save that sealed nothing, or sealed to the wrong key, fails here.
@MainActor
final class ContactFormViewModelTests: XCTestCase {

    private static let pin = "12345678"
    private let hubId = "hub-contact-form"
    private let baseURL = URL(string: "https://hub.example.org")!

    private let contactName = "Maria Gonzalez Ruiz"
    private let contactPhone = "+15551234567"
    private let contactEmail = "maria@example.org"
    private let contactNotes = "prefers evening calls"

    private struct Member {
        let blob: EncryptedDeviceKeys
        var x25519PubkeyHex: String { blob.state.encryptionPubkeyHex }
    }

    /// The device that writes the contact (loaded when `world()` returns), the admin who is the
    /// second reader, and a member nobody sealed to.
    private struct World {
        let author: Member
        let admin: Member
        let stranger: Member
        let service: CryptoService
    }

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        // The Rust FFI crypto state is process-global; start from a known state.
        CryptoService().lock()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        CryptoService().lock()
        super.tearDown()
    }

    private func world() throws -> World {
        let service = CryptoService()
        let admin = Member(blob: try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: Self.pin))
        let stranger = Member(blob: try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: Self.pin))
        let author = Member(blob: try service.generateDeviceKeys(deviceId: UUID().uuidString, pin: Self.pin))
        // Precondition of the whole file: this hub's key was never loaded. A contact must not need it.
        XCTAssertFalse(service.hasHubKey(hubId: hubId), "the test hub must hold no key")
        return World(author: author, admin: admin, stranger: stranger, service: service)
    }

    private func contactsAPI(_ crypto: CryptoService) -> ContactsAPIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        let hubContext = HubContext()
        hubContext.setActiveHub(hubId)
        let api = APIService(cryptoService: crypto, hubContext: hubContext, sessionConfiguration: config)
        api.configure(baseURL: baseURL)
        return ContactsAPIService(apiService: api)
    }

    /// The stored row as `POST`/`PATCH /api/directory` answers it.
    private func stubServer() {
        MockURLProtocol.requestHandler = { [hubId] _ in
            let row = """
            {"id":"contact-1","hubId":"\(hubId)","encryptedSummary":"00","summaryEnvelopes":[],
             "identifierHashes":[],"tagHashes":[],"blindIndexes":{},"caseCount":0,"noteCount":0,
             "interactionCount":0,"lastInteractionAt":"2026-01-01T00:00:00Z",
             "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
            """
            return (200, Data(row.utf8))
        }
    }

    private func fill(_ vm: ContactFormViewModel) {
        vm.displayName = contactName
        vm.phone = contactPhone
        vm.email = contactEmail
        vm.notes = contactNotes
    }

    /// The single write the mock captured, exactly as the server would receive it.
    private func onlyWrite(method: String, path: String) throws -> (raw: String, json: [String: Any]) {
        let writes = MockURLProtocol.capturedRequests.filter { $0.httpMethod == method }
        XCTAssertEqual(writes.count, 1, "expected exactly one \(method), got \(writes.map { $0.url?.path ?? "?" })")
        XCTAssertEqual(writes.first?.url?.path, path)
        let body = try XCTUnwrap(MockURLProtocol.capturedBodies.first, "the \(method) carried no body")
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        return (String(decoding: body, as: UTF8.self), json)
    }

    private func envelope(_ raw: Any?, for pubkey: String) throws -> HpkeEnvelope {
        let all = try XCTUnwrap(raw as? [[String: String]], "expected an envelope array, got \(String(describing: raw))")
        let mine = try XCTUnwrap(
            all.first { $0["pubkey"] == pubkey },
            "no envelope for \(pubkey); readers: \(all.compactMap { $0["pubkey"] })"
        )
        return HpkeEnvelope(enc: try XCTUnwrap(mine["enc"]), ct: try XCTUnwrap(mine["ct"]))
    }

    private func open(
        _ json: [String: Any], tier: String, as member: Member, shape: Shape, _ w: World
    ) throws -> [String: Any] {
        _ = try w.service.unlockWithPin(data: member.blob, pin: Self.pin)
        let ciphertext = try XCTUnwrap(json[tier == "summary" ? "encryptedSummary" : "encryptedPII"] as? String)
        let env = try envelope(json[tier == "summary" ? "summaryEnvelopes" : "piiEnvelopes"], for: member.x25519PubkeyHex)
        let plaintext = try w.service.decryptContactData(ciphertextHex: ciphertext, envelope: env, shape: shape)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(plaintext.utf8)) as? [String: Any])
    }

    private func assertOpensForTheSecondReader(_ json: [String: Any], _ w: World) throws {
        let summary = try open(json, tier: "summary", as: w.admin, shape: .contactProfileKey, w)
        XCTAssertEqual(summary["displayName"] as? String, contactName, "the second reader cannot open the stored summary")

        let pii = try open(json, tier: "pii", as: w.admin, shape: .contactIdKey, w)
        XCTAssertEqual(pii["notes"] as? String, contactNotes)
        let identifiers = try XCTUnwrap(pii["identifiers"] as? [[String: Any]])
        XCTAssertEqual(Set(identifiers.compactMap { $0["value"] as? String }), [contactPhone, contactEmail])

        // A device nobody sealed to has no envelope, and its key opens none of the others.
        _ = try w.service.unlockWithPin(data: w.stranger.blob, pin: Self.pin)
        let adminEnv = try envelope(json["summaryEnvelopes"], for: w.admin.x25519PubkeyHex)
        XCTAssertThrowsError(
            try w.service.decryptContactData(
                ciphertextHex: try XCTUnwrap(json["encryptedSummary"] as? String),
                envelope: adminEnv,
                shape: .contactProfileKey
            ),
            "a member the contact was not sealed to opened it"
        )
    }

    /// No byte of the contact's personal data, and nothing derived from it, may leave the device
    /// in the clear: the server stores every field of this body verbatim.
    private func assertNothingDerivedFromThePII(_ raw: String, _ json: [String: Any]) {
        let wire = raw.lowercased()
        for secret in [contactName, contactPhone, contactEmail, contactNotes, "gonzalez", "5551234567"] {
            XCTAssertFalse(wire.contains(secret.lowercased()), "the request body carries \"\(secret)\"")
        }
        for key in ["nameHash", "trigramTokens"] {
            XCTAssertNil(json[key], "\(key) is a search index: the hub key that would key it never enters Swift (#2779)")
        }
        XCTAssertTrue((json["identifierHashes"] as? [String] ?? []).isEmpty)
    }

    // MARK: - Create

    func testCreateSealsTheContactForEveryReaderAndNeedsNoHubKey() async throws {
        let w = try world()
        stubServer()
        let vm = ContactFormViewModel(cryptoService: w.service)
        fill(vm)

        _ = try await vm.save(
            hubId: hubId,
            readerPubkeys: [w.author.x25519PubkeyHex, w.admin.x25519PubkeyHex],
            apiService: contactsAPI(w.service)
        )

        let (raw, json) = try onlyWrite(method: "POST", path: "/api/hubs/\(hubId)/directory")
        XCTAssertEqual(json["hubId"] as? String, hubId)
        assertNothingDerivedFromThePII(raw, json)
        try assertOpensForTheSecondReader(json, w)
    }

    func testCreateWithoutPhoneOrEmailSealsNoPIITier() async throws {
        let w = try world()
        stubServer()
        let vm = ContactFormViewModel(cryptoService: w.service)
        vm.displayName = contactName

        _ = try await vm.save(
            hubId: hubId,
            readerPubkeys: [w.admin.x25519PubkeyHex],
            apiService: contactsAPI(w.service)
        )

        let (_, json) = try onlyWrite(method: "POST", path: "/api/hubs/\(hubId)/directory")
        XCTAssertNil(json["encryptedPII"])
        let summary = try open(json, tier: "summary", as: w.admin, shape: .contactProfileKey, w)
        XCTAssertEqual(summary["displayName"] as? String, contactName)
    }

    func testCreateRefusesAnEmptyNameWithoutSendingAnything() async throws {
        let w = try world()
        stubServer()
        let vm = ContactFormViewModel(cryptoService: w.service)
        vm.displayName = "   "

        do {
            _ = try await vm.save(hubId: hubId, readerPubkeys: [w.admin.x25519PubkeyHex], apiService: contactsAPI(w.service))
            XCTFail("an empty name was saved")
        } catch ContactFormError.emptyDisplayName {
            XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty, "a refused save still reached the server")
        }
    }

    // MARK: - Edit

    func testEditSealsTheChangedContactForEveryReaderAndNeedsNoHubKey() async throws {
        let w = try world()
        stubServer()
        let vm = ContactFormViewModel(cryptoService: w.service)
        fill(vm)

        _ = try await vm.update(
            contactId: "contact-1",
            hubId: hubId,
            readerPubkeys: [w.author.x25519PubkeyHex, w.admin.x25519PubkeyHex],
            apiService: contactsAPI(w.service)
        )

        let (raw, json) = try onlyWrite(method: "PATCH", path: "/api/hubs/\(hubId)/directory/contact-1")
        assertNothingDerivedFromThePII(raw, json)
        try assertOpensForTheSecondReader(json, w)
    }
}
