import Foundation
import XCTest
@testable import Llamenos

/// Regression coverage for the admin reader envelopes on the two client-side
/// encryption paths that had none: case comments
/// (`CaseManagementViewModel.addComment`) and event details
/// (`EventsViewModel.createEvent`).
///
/// Both call sites used to pass `readerPubkeys: []` with the comment "Server
/// adds admin pubkeys". The server does no such thing: `CasesService`
/// persists `contentEnvelopes` / `detailEnvelopes` exactly as submitted, so a
/// payload wrapped only for the author's own device key is permanently
/// unreadable to every admin — breaking the accountability guarantee in
/// `docs/security/CRYPTO_ARCHITECTURE.md` with no visible symptom.
///
/// These tests assert the wire envelope set, which is the only place the defect
/// was observable, and pin the camelCase body shape the route validators
/// (`createInteractionBodySchema`, `createEventBodySchema`) require.
final class AdminReaderEnvelopeTests: XCTestCase {

    private let testBaseURL = URL(string: "https://hub.example.org")!

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        // The Rust FFI crypto state is process-global; start from a known state.
        CryptoService().lock()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    // MARK: - Case comments

    func testAddCommentWrapsTheCommentForEveryAdminReader() async throws {
        let (crypto, authorPubkey, adminPubkey) = try makeAuthorAndAdminKeys()
        let apiService = makeAPIService(cryptoService: crypto)

        MockURLProtocol.requestHandler = { request in
            // The timeline reload after a successful comment must not fail the path.
            if request.httpMethod == "GET" {
                return (200, Data(#"{"interactions":[],"total":0}"#.utf8))
            }
            return (201, Data(#"{"id":"int-1","caseId":"rec-1","interactionType":"comment","interactionTypeHash":"comment_hash","authorPubkey":"x","createdAt":"2026-01-01T00:00:00Z"}"#.utf8))
        }

        let viewModel = CaseManagementViewModel(apiService: apiService, cryptoService: crypto)
        await viewModel.addComment(recordId: "rec-1", text: "handled, caller safe", adminPubkeys: [adminPubkey])

        let json = try onlyPostedBody(pathSuffix: "/records/rec-1/interactions")

        // camelCase keys, or `createInteractionBodySchema` rejects the request.
        XCTAssertEqual(json["interactionType"] as? String, "comment", "got \(json.keys.sorted())")
        XCTAssertNotNil(json["interactionTypeHash"], "got \(json.keys.sorted())")
        XCTAssertNil(json["interaction_type"], "body must not be snake_cased: \(json.keys.sorted())")

        let pubkeys = try envelopePubkeys(json["contentEnvelopes"])
        XCTAssertTrue(
            pubkeys.contains(authorPubkey),
            "the author must keep access to their own comment; envelopes: \(pubkeys)"
        )
        XCTAssertTrue(
            pubkeys.contains(adminPubkey),
            "every admin reader must be wrapped for client-side — the server never adds one; envelopes: \(pubkeys)"
        )
    }

    func testAddCommentWithNoAdminStillWrapsForTheAuthor() async throws {
        let (crypto, authorPubkey, _) = try makeAuthorAndAdminKeys()
        let apiService = makeAPIService(cryptoService: crypto)

        MockURLProtocol.requestHandler = { request in
            if request.httpMethod == "GET" {
                return (200, Data(#"{"interactions":[],"total":0}"#.utf8))
            }
            return (201, Data(#"{"id":"int-1"}"#.utf8))
        }

        let viewModel = CaseManagementViewModel(apiService: apiService, cryptoService: crypto)
        await viewModel.addComment(recordId: "rec-1", text: "note to self", adminPubkeys: [])

        let json = try onlyPostedBody(pathSuffix: "/records/rec-1/interactions")
        let pubkeys = try envelopePubkeys(json["contentEnvelopes"])
        XCTAssertEqual(pubkeys, [authorPubkey], "with no admin configured the author is the only reader")
    }

    // MARK: - Event details

    func testCreateEventWrapsTheDetailsForEveryAdminReader() async throws {
        let (crypto, authorPubkey, adminPubkey) = try makeAuthorAndAdminKeys()
        let apiService = makeAPIService(cryptoService: crypto)

        MockURLProtocol.requestHandler = { request in
            if request.httpMethod == "GET" {
                return (200, Data(#"{"events":[],"total":0}"#.utf8))
            }
            return (201, Data(#"{"id":"evt-1"}"#.utf8))
        }

        let viewModel = EventsViewModel(apiService: apiService, cryptoService: crypto)
        _ = await viewModel.createEvent(
            entityTypeId: "et-1",
            title: "community meeting",
            description: nil,
            startDate: Date(timeIntervalSince1970: 1_800_000_000),
            endDate: nil,
            location: nil,
            adminPubkeys: [adminPubkey]
        )

        let json = try onlyPostedBody(pathSuffix: "/events")

        // camelCase keys, or `createEventBodySchema` rejects the request.
        XCTAssertNotNil(json["entityTypeId"], "got \(json.keys.sorted())")
        XCTAssertNil(json["entity_type_id"], "body must not be snake_cased: \(json.keys.sorted())")

        let pubkeys = try envelopePubkeys(json["detailEnvelopes"])
        XCTAssertTrue(
            pubkeys.contains(authorPubkey),
            "the author must keep access to the event they created; envelopes: \(pubkeys)"
        )
        XCTAssertTrue(
            pubkeys.contains(adminPubkey),
            "every admin reader must be wrapped for client-side — the server never adds one; envelopes: \(pubkeys)"
        )
    }

    // MARK: - Helpers

    /// Generates an admin keypair first, then the author's, so the process-global
    /// FFI crypto state ends up holding the author's private key while a real
    /// (HPKE-sealable) admin X25519 pubkey is still available to wrap for.
    private func makeAuthorAndAdminKeys() throws -> (CryptoService, author: String, admin: String) {
        let adminService = CryptoService()
        _ = try adminService.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let adminPubkey = try XCTUnwrap(adminService.encryptionPubkeyHex)

        let authorService = CryptoService()
        _ = try authorService.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let authorPubkey = try XCTUnwrap(authorService.encryptionPubkeyHex)

        XCTAssertNotEqual(adminPubkey, authorPubkey)
        return (authorService, authorPubkey, adminPubkey)
    }

    private func makeAPIService(cryptoService: CryptoService) -> APIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let apiService = APIService(
            cryptoService: cryptoService,
            hubContext: HubContext(),
            sessionConfiguration: config
        )
        apiService.configure(baseURL: testBaseURL)
        return apiService
    }

    /// The single POST body captured by the mock. Only writes carry a body, so
    /// `capturedBodies` holds exactly the POST this test performed. `suffix` is
    /// matched on the tail of the path because `APIService.hp` rewrites
    /// `/api/records/...` to `/api/hubs/<id>/records/...` whenever a hub is
    /// active, and this test is not about hub scoping.
    private func onlyPostedBody(pathSuffix suffix: String) throws -> [String: Any] {
        let posts = MockURLProtocol.capturedRequests.filter { $0.httpMethod == "POST" }
        XCTAssertEqual(posts.count, 1, "expected exactly one POST, got \(posts.map { $0.url?.path ?? "?" })")
        XCTAssertTrue(
            posts.first?.url?.path.hasSuffix(suffix) == true,
            "POST went to \(posts.first?.url?.path ?? "?"), expected a path ending in \(suffix)"
        )
        let body = try XCTUnwrap(MockURLProtocol.capturedBodies.first, "the POST carried no body")
        return try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any],
            "POST body is not a JSON object"
        )
    }

    private func envelopePubkeys(_ raw: Any?) throws -> [String] {
        let envelopes = try XCTUnwrap(raw as? [[String: Any]], "expected an envelope array, got \(String(describing: raw))")
        for envelope in envelopes {
            XCTAssertNotNil(envelope["ct"], "every envelope carries a wrapped key")
            XCTAssertNotNil(envelope["enc"], "every envelope carries its HPKE encapsulation")
        }
        return envelopes.compactMap { $0["pubkey"] as? String }
    }
}
