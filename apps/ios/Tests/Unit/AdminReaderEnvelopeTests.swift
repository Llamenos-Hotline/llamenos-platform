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
    /// Records and events are hub-owned (#2461): with no active hub the write has no
    /// path to go to, so every test below writes into this one explicitly — never into
    /// whatever `activeHubId` an earlier test left in `UserDefaults`.
    private let hubId = "hub-envelopes"

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        // The Rust FFI crypto state is process-global; start from a known state.
        CryptoService().lock()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    // MARK: - Case comments

    @MainActor
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

        let json = try onlyPostedBody(path: "/api/hubs/\(hubId)/records/rec-1/interactions")

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

    @MainActor
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

        let json = try onlyPostedBody(path: "/api/hubs/\(hubId)/records/rec-1/interactions")
        let pubkeys = try envelopePubkeys(json["contentEnvelopes"])
        XCTAssertEqual(pubkeys, [authorPubkey], "with no admin configured the author is the only reader")
    }

    // MARK: - Event details

    @MainActor
    func testCreateEventWrapsTheDetailsForEveryAdminReader() async throws {
        let (crypto, authorPubkey, adminPubkey) = try makeAuthorAndAdminKeys()
        let apiService = makeAPIService(cryptoService: crypto)

        let eventTypes = ProtocolFixtures.entityTypeListJSON([
            ProtocolFixtures.entityTypeJSON(id: "et-1", name: "meeting", category: "event"),
        ])
        MockURLProtocol.requestHandler = { request in
            if request.httpMethod == "GET" {
                let path = request.url?.path ?? ""
                if path.hasSuffix("/settings/cms/case-management") {
                    return (200, Data(#"{"enabled":true}"#.utf8))
                }
                if path.hasSuffix("/settings/cms/entity-types") {
                    return (200, Data(eventTypes.utf8))
                }
                return (200, Data(ProtocolFixtures.emptyEventList.utf8))
            }
            return (201, Data(#"{"id":"evt-1"}"#.utf8))
        }

        // createEvent takes its event type's identifiers from the loaded entity types.
        let viewModel = EventsViewModel(apiService: apiService, cryptoService: crypto)
        await viewModel.loadInitial()
        _ = await viewModel.createEvent(
            entityTypeId: "et-1",
            title: "community meeting",
            description: nil,
            startDate: Date(timeIntervalSince1970: 1_800_000_000),
            endDate: nil,
            location: nil,
            adminPubkeys: [adminPubkey]
        )

        let json = try onlyPostedBody(path: "/api/hubs/\(hubId)/events")

        // camelCase keys, or `createEventBodySchema` rejects the request.
        XCTAssertNotNil(json["entityTypeId"], "got \(json.keys.sorted())")
        XCTAssertNil(json["entity_type_id"], "body must not be snake_cased: \(json.keys.sorted())")
        // `createEventBodySchema` requires both discriminators; they come from the entity type.
        XCTAssertEqual(json["eventTypeHash"] as? String, "et-1", "got \(json.keys.sorted())")
        XCTAssertEqual(json["statusHash"] as? String, "open", "got \(json.keys.sorted())")

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

    // MARK: - No active hub

    /// A comment with no hub to write into must fail where the volunteer can see it.
    /// Before #2461 the write went to the unscoped path; now there is no path, and a
    /// write that silently never fired would be a note the volunteer believes is saved.
    @MainActor
    func testAddCommentWithNoActiveHubSurfacesAnErrorAndSendsNothing() async throws {
        let (crypto, _, adminPubkey) = try makeAuthorAndAdminKeys()
        let apiService = makeAPIService(cryptoService: crypto, withActiveHub: false)
        MockURLProtocol.requestHandler = { _ in (201, Data(#"{"id":"int-1"}"#.utf8)) }

        let viewModel = CaseManagementViewModel(apiService: apiService, cryptoService: crypto)
        await viewModel.addComment(recordId: "rec-1", text: "handled, caller safe", adminPubkeys: [adminPubkey])

        XCTAssertEqual(
            MockURLProtocol.capturedRequests.map { $0.url?.path ?? "?" }, [],
            "with no hub there is no hub-owned path to write to"
        )
        XCTAssertEqual(
            viewModel.errorMessage, APIError.noActiveHub.errorDescription,
            "a comment that was not saved must say so, never no-op"
        )
    }

    /// The same for an event: `createEvent` reports failure and says why.
    @MainActor
    func testCreateEventWithNoActiveHubSurfacesAnErrorAndSendsNothing() async throws {
        let (crypto, _, adminPubkey) = try makeAuthorAndAdminKeys()
        let apiService = makeAPIService(cryptoService: crypto, withActiveHub: false)
        let eventTypes = ProtocolFixtures.entityTypeListJSON([
            ProtocolFixtures.entityTypeJSON(id: "et-1", name: "meeting", category: "event"),
        ])
        MockURLProtocol.requestHandler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/settings/cms/case-management") {
                return (200, Data(#"{"enabled":true}"#.utf8))
            }
            if path.hasSuffix("/settings/cms/entity-types") {
                return (200, Data(eventTypes.utf8))
            }
            return (201, Data(#"{"id":"evt-1"}"#.utf8))
        }

        let viewModel = EventsViewModel(apiService: apiService, cryptoService: crypto)
        await viewModel.loadInitial()
        let created = await viewModel.createEvent(
            entityTypeId: "et-1",
            title: "community meeting",
            description: nil,
            startDate: Date(timeIntervalSince1970: 1_800_000_000),
            endDate: nil,
            location: nil,
            adminPubkeys: [adminPubkey]
        )

        XCTAssertFalse(created, "an event that was not saved must not report success")
        XCTAssertEqual(
            MockURLProtocol.capturedRequests.filter { $0.httpMethod == "POST" }.map { $0.url?.path ?? "?" }, [],
            "with no hub there is no hub-owned path to write to"
        )
        XCTAssertEqual(
            viewModel.errorMessage, APIError.noActiveHub.errorDescription,
            "an event that was not saved must say so, never no-op"
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

    /// A client browsing `hubId`, or — `withActiveHub: false` — one with no hub selected.
    private func makeAPIService(cryptoService: CryptoService, withActiveHub: Bool = true) -> APIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        let hubContext = HubContext()
        if withActiveHub {
            hubContext.setActiveHub(hubId)
        }
        let apiService = APIService(
            cryptoService: cryptoService,
            hubContext: hubContext,
            sessionConfiguration: config
        )
        apiService.configure(baseURL: testBaseURL)
        return apiService
    }

    /// The single POST body captured by the mock. Only writes carry a body, so
    /// `capturedBodies` holds exactly the POST this test performed. `path` is the
    /// full hub-scoped path: records and events have no unscoped route (#2461).
    private func onlyPostedBody(path expected: String) throws -> [String: Any] {
        let posts = MockURLProtocol.capturedRequests.filter { $0.httpMethod == "POST" }
        XCTAssertEqual(posts.count, 1, "expected exactly one POST, got \(posts.map { $0.url?.path ?? "?" })")
        XCTAssertEqual(
            posts.first?.url?.path, expected,
            "POST went to \(posts.first?.url?.path ?? "?"), expected \(expected)"
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
