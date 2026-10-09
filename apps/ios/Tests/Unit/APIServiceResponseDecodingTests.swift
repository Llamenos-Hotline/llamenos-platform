import Foundation
import XCTest
@testable import Llamenos

/// #1633 — what iOS must be able to *receive*.
///
/// `APIServiceWireFormatTests` pins the bytes iOS sends. Nothing pinned the bytes it
/// can decode, and that asymmetry is how this PR first regressed: the request key for
/// `POST /api/conversations/:id/messages` was renamed to `readerEnvelopes` to match
/// `sendMessageBodySchema`, while `ConversationMessage` — the response model for the
/// same endpoint, in the same file — still required `recipientEnvelopes`.
///
/// The failure mode mattered more than the mismatch. While iOS snake_cased its request
/// keys the send 400'd, so the response was never decoded and the bug was unreachable.
/// Once the send validated, the message was **stored and marked delivered** and only
/// then did the decode throw `keyNotFound` — so `ConversationsViewModel` reported
/// failure for a reply that had already gone out, and the volunteer's natural retry
/// double-sends to a caller on a crisis line.
///
/// So: a renamed request key obliges you to check the response model on the same
/// endpoint. These tests decode fixtures from
/// `apps/ios/Tests/Wire/ios-response-bodies.json` through `APIService`'s real decoder,
/// and `apps/worker/__tests__/unit/ios-wire-bodies.test.ts` holds those same fixtures
/// to the real Zod response schemas — including asserting that every key these models
/// *require* is one the schema actually declares.
final class APIServiceResponseDecodingTests: XCTestCase {

    /// The production decoder, not a re-created one: a response test that builds its
    /// own decoder proves only that the test is self-consistent.
    private let decoder = APIService.makeResponseDecoder()

    // MARK: - Fixture access

    private static var fixtureURL: URL? {
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/Unit
            .deletingLastPathComponent()   // Tests
        let candidate = dir.appendingPathComponent("Wire/ios-response-bodies.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        for _ in 0..<3 {
            dir = dir.deletingLastPathComponent()
            let alt = dir.appendingPathComponent("apps/ios/Tests/Wire/ios-response-bodies.json")
            if FileManager.default.fileExists(atPath: alt.path) { return alt }
        }
        return nil
    }

    /// The raw bytes recorded for `id`, exactly as the fixture holds them.
    private func payload(_ id: String) throws -> Data {
        guard let url = Self.fixtureURL else {
            throw XCTSkip("ios-response-bodies.json not reachable; run from a source checkout")
        }
        let root = try JSONSerialization.jsonObject(with: try Data(contentsOf: url))
        guard let dict = root as? [String: Any],
              let responses = dict["responses"] as? [String: Any],
              let one = responses[id]
        else {
            XCTFail("ios-response-bodies.json has no responses.\(id)")
            return Data()
        }
        return try JSONSerialization.data(withJSONObject: one, options: [.sortedKeys])
    }

    // MARK: - The regression

    func testAMessageFromTheServerDecodes() throws {
        let data = try payload("message")
        let message = try decoder.decode(ConversationMessage.self, from: data)

        XCTAssertEqual(message.conversationId, "33333333-3333-4333-8333-333333333333")
        XCTAssertEqual(message.direction, "outbound")
        XCTAssertFalse(message.encryptedContent.isEmpty)
        XCTAssertEqual(message.readerEnvelopes.count, 1)
        XCTAssertEqual(message.readerEnvelopes.first?.pubkey, String(repeating: "ab", count: 32))
        // `readAt` arrives as JSON null for an unread message; `String?` takes that as nil.
        XCTAssertNil(message.readAt)
        XCTAssertFalse(message.isRead)
    }

    /// The 201 from a send is decoded on the path that reports success to the volunteer,
    /// so a decode failure there is indistinguishable from a send failure. This is the
    /// assertion that would have caught the regression.
    func testTheSendResponseDecodesSoASentMessageIsNotReportedAsFailed() throws {
        let data = try payload("message")
        XCTAssertNoThrow(
            try decoder.decode(ConversationMessage.self, from: data),
            """
            The 201 from POST /api/conversations/:id/messages must decode. If it throws, \
            ConversationsViewModel.sendReply reports failure for a message the server \
            already stored and delivered, and the retry duplicates it to the caller.
            """
        )
    }

    func testAConversationFromTheServerDecodes() throws {
        let data = try payload("conversation")
        let conversation = try decoder.decode(AppConversation.self, from: data)

        XCTAssertEqual(conversation.channelType, "sms")
        // The server's key is `contactIdentifierHash`; `contactHash` was never sent.
        XCTAssertEqual(conversation.contactHash, "deadbeefdeadbeef")
        // The server's key is `assignedTo`; as `assignedVolunteerPubkey` this silently
        // read nil, so every conversation looked unassigned.
        XCTAssertEqual(conversation.assignedVolunteerPubkey, String(repeating: "ab", count: 32))
        XCTAssertEqual(conversation.status, "active")
    }

    /// The server has no per-user unread count, so its absence must be tolerated —
    /// but as a required `Int` it was `keyNotFound`, losing the whole conversation list.
    func testAConversationDecodesWithoutAnUnreadCountAndReportsZero() throws {
        let data = try payload("conversation")
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        XCTAssertNil(json["unreadCount"], "the fixture must not supply a key the server lacks")

        let conversation = try decoder.decode(AppConversation.self, from: data)
        XCTAssertEqual(conversation.unreadCount, 0)
    }

    // MARK: - The inverse: these models must fail on the keys they used to want

    /// Guards the fix from being reverted by a well-meaning rename. If a model goes
    /// back to the old key, the server payload stops decoding — assert that directly,
    /// so "it decodes" cannot be satisfied by a model that accepts either spelling.
    func testTheOldKeysDoNotDecodeTheServersPayload() throws {
        /// `ConversationMessage` as it was before this change.
        struct LegacyConversationMessage: Decodable {
            let id: String
            let conversationId: String
            let direction: String
            let encryptedContent: String
            let recipientEnvelopes: [RecipientEnvelope]
            let channelType: String
            let createdAt: String
            let readAt: String?
        }
        /// `AppConversation` as it was before this change.
        struct LegacyAppConversation: Decodable {
            let id: String
            let channelType: String
            let contactHash: String
            let status: String
            let unreadCount: Int
            let createdAt: String
        }

        let message = try payload("message")
        XCTAssertThrowsError(
            try decoder.decode(LegacyConversationMessage.self, from: message),
            "the old model required recipientEnvelopes and channelType, neither of which a message row carries"
        ) { error in
            guard case DecodingError.keyNotFound(let key, _) = error else {
                return XCTFail("expected keyNotFound, got \(error)")
            }
            XCTAssertTrue(
                ["recipientEnvelopes", "channelType"].contains(key.stringValue),
                "unexpected missing key \(key.stringValue)"
            )
        }

        let conversation = try payload("conversation")
        XCTAssertThrowsError(
            try decoder.decode(LegacyAppConversation.self, from: conversation),
            "the old model required contactHash and unreadCount, neither of which the server sends"
        ) { error in
            guard case DecodingError.keyNotFound(let key, _) = error else {
                return XCTFail("expected keyNotFound, got \(error)")
            }
            XCTAssertTrue(
                ["contactHash", "unreadCount"].contains(key.stringValue),
                "unexpected missing key \(key.stringValue)"
            )
        }
    }

    /// `.convertFromSnakeCase` is retained on the response decoder, and it is routinely
    /// mistaken for a safety net. It is not: it cannot rename anything, it only splits
    /// on underscores. Pinned so nobody argues a model/schema disagreement is covered.
    func testTheSnakeCaseStrategyCannotBridgeARename() throws {
        struct TwoWords: Decodable { let readerEnvelopes: [RecipientEnvelope] }
        // A genuinely snake_case key still decodes — that is all the strategy buys.
        let snake = Data(#"{"reader_envelopes":[{"ct":"a","enc":"b","pubkey":"c"}]}"#.utf8)
        XCTAssertNoThrow(try decoder.decode(TwoWords.self, from: snake))

        // A *differently named* key does not, however close the meaning.
        let renamed = Data(#"{"recipientEnvelopes":[{"ct":"a","enc":"b","pubkey":"c"}]}"#.utf8)
        XCTAssertThrowsError(try decoder.decode(TwoWords.self, from: renamed))
    }

    // MARK: - #1246 — record contacts

    /// GET /api/hubs/:hubId/records/:id/contacts serializes raw `case_contacts` rows:
    /// the record key is `caseId` (the schema says `recordId`) and `role` is nullable
    /// (the schema requires a string). Until the route is aligned with
    /// `recordContactListResponseSchema`, a strict `RecordContact` decode throws
    /// `keyNotFound` on every non-empty list and the Contacts tab shows its empty
    /// state for a case that has contacts. These bodies stay inline rather than in
    /// the shared fixture file because the worker-side schema test holds that file
    /// to the Zod schema — and the schema is right; it is the route that deviates.
    func testRecordContactsDecodeFromTheRowShapeTheRouteActuallySends() throws {
        let body = Data(#"""
        {"contacts": [{
            "caseId": "11111111-1111-4111-8111-111111111111",
            "contactId": "22222222-2222-4222-8222-222222222222",
            "role": null,
            "addedAt": "2026-10-09T12:00:00.000Z",
            "addedBy": "deadbeef"
        }]}
        """#.utf8)
        let response = try decoder.decode(RecordContactsResponse.self, from: body)

        XCTAssertEqual(response.contacts.count, 1)
        XCTAssertEqual(response.contacts[0].recordID, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(response.contacts[0].contactID, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(response.contacts[0].role, "")
    }

    /// The schema shape must keep decoding — once the route is aligned with
    /// `recordContactListResponseSchema` this is the body that arrives.
    func testRecordContactsDecodeFromTheSchemaShape() throws {
        let body = Data(#"""
        {"contacts": [{
            "recordId": "11111111-1111-4111-8111-111111111111",
            "contactId": "22222222-2222-4222-8222-222222222222",
            "role": "legal_observer",
            "addedAt": "2026-10-09T12:00:00.000Z",
            "addedBy": "deadbeef"
        }]}
        """#.utf8)
        let response = try decoder.decode(RecordContactsResponse.self, from: body)

        XCTAssertEqual(response.contacts.count, 1)
        XCTAssertEqual(response.contacts[0].recordID, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(response.contacts[0].role, "legal_observer")
    }
}
