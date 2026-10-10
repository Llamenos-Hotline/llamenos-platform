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

    // MARK: - #1724: the four admin settings screens

    /// Each of these screens decoded its route's answer into a hand-written
    /// `Client*` struct naming fields the server does not have, so the GET threw
    /// and the screen fell back to hardcoded defaults behind an error banner.
    /// The generated types must decode the real payload, and — asserted
    /// directly, so "it decodes" cannot be satisfied by a model that accepts
    /// either spelling — the hand-written ones must not.

    func testTheStoredTelephonyProviderDecodes() throws {
        let provider = try decoder.decode(TelephonyProvider.self, from: try payload("telephonyProvider"))
        XCTAssertEqual(provider.type, .twilio)
        XCTAssertEqual(provider.phoneNumber, "+15550001111")
        XCTAssertEqual(provider.accountSid, "AC" + String(repeating: "a", count: 32))
    }

    /// `GET /api/settings/telephony-provider` answers a bare `null` until a
    /// provider has been configured. The screen's empty state depends on that
    /// decoding to nil rather than throwing.
    func testAnUnconfiguredTelephonyProviderDecodesAsNil() throws {
        let value = try decoder.decode(TelephonyProvider?.self, from: Data("null".utf8))
        XCTAssertNil(value)
    }

    func testTheStoredTranscriptionSettingsDecode() throws {
        let settings = try decoder.decode(
            TranscriptionSettings.self, from: try payload("transcriptionSettings")
        )
        XCTAssertEqual(settings.globalEnabled, true)
        XCTAssertEqual(settings.allowUserOptOut, false)
    }

    func testTheStoredSpamSettingsDecode() throws {
        let settings = try decoder.decode(SpamSettings.self, from: try payload("spamSettings"))
        XCTAssertEqual(settings.maxCallsPerMinute, 3)
        XCTAssertEqual(settings.blockDurationMinutes, 30)
        XCTAssertEqual(settings.rateLimitEnabled, true)
        XCTAssertEqual(settings.voiceCAPTCHAEnabled, false)
    }

    func testTheStoredIvrLanguagesDecodeInOrder() throws {
        let languages = try decoder.decode(IvrLanguages.self, from: try payload("ivrLanguages"))
        XCTAssertEqual(
            languages.enabledLanguages, ["es", "en", "zh"],
            "position decides the keypad digit, so the order is part of the value"
        )
    }

    /// The models these screens used to use, against the payloads the server
    /// really sends.
    ///
    /// Three of the four throw `keyNotFound` — the whole response is lost, not
    /// just a field. The fourth is worse: `ClientSpamSettings` would have read a
    /// per-minute limit as a per-hour one had its key matched, and the bypass it
    /// offered does not exist server-side at all.
    func testTheHandWrittenModelsCannotDecodeTheServersPayloads() throws {
        struct LegacyTelephonySettings: Decodable {
            let provider: String
            let accountSid: String
            let authToken: String
            let phoneNumber: String
        }
        struct LegacyTranscriptionSettings: Decodable {
            let enabled: Bool
            let allowVolunteerOptOut: Bool
        }
        struct LegacySpamSettings: Decodable {
            let maxCallsPerHour: Int
            let voiceCaptchaEnabled: Bool
            let knownNumberBypass: Bool
        }
        struct LegacyIvrLanguages: Decodable {
            let languages: [String: Bool]
        }

        try assertKeyNotFound(
            LegacyTelephonySettings.self, in: try payload("telephonyProvider"), expecting: "provider",
            "the provider's own key is `type`; `provider` was never sent"
        )
        try assertKeyNotFound(
            LegacyTranscriptionSettings.self, in: try payload("transcriptionSettings"),
            expecting: "enabled",
            "the server's keys are globalEnabled / allowUserOptOut"
        )
        try assertKeyNotFound(
            LegacySpamSettings.self, in: try payload("spamSettings"), expecting: "maxCallsPerHour",
            "the server's rate limit is maxCallsPerMinute, and it has no knownNumberBypass"
        )
        try assertKeyNotFound(
            LegacyIvrLanguages.self, in: try payload("ivrLanguages"), expecting: "languages",
            "the server sends an ordered enabledLanguages array, not a code->bool map"
        )
    }

    private func assertKeyNotFound<T: Decodable>(
        _ type: T.Type, in data: Data, expecting key: String, _ why: String,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        XCTAssertThrowsError(try decoder.decode(type, from: data), why, file: file, line: line) { error in
            guard case DecodingError.keyNotFound(let missing, _) = error else {
                return XCTFail("expected keyNotFound, got \(error)", file: file, line: line)
            }
            XCTAssertEqual(missing.stringValue, key, why, file: file, line: line)
        }
    }

    // MARK: - #1032: recovery group info

    /// The hand-written `AppRecoveryGroupInfo` required `publicKey` and `commitments`,
    /// keys `recoveryGroupInfoSchema` has never sent, so the config screen decoded
    /// nothing and always showed "not configured". The generated type must decode the
    /// real payload — and, asserted directly, the old shape must not.
    func testTheRecoveryGroupInfoDecodes() throws {
        let info = try decoder.decode(RecoveryGroupInfo.self, from: try payload("recoveryGroupInfo"))
        XCTAssertEqual(info.groupPublicKey, String(repeating: "ab", count: 32))
        XCTAssertEqual(info.hubID, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(Int(info.threshold), 2)
        XCTAssertEqual(Int(info.totalShares), 3)
        XCTAssertEqual(info.shareCommitments.count, 3)
        XCTAssertEqual(info.shareHolderLiveness.count, 3)
        XCTAssertEqual(info.rotatedAt, "2026-01-03T00:00:00.000Z")
        XCTAssertEqual(info.duressCommitments?.compactMap { $0 }.count, 1)
    }

    func testTheHandWrittenRecoveryGroupInfoCannotDecodeTheServersPayload() throws {
        /// `AppRecoveryGroupInfo` as it was before this change (`publicKey` first, so
        /// it is the key decode fails on).
        struct LegacyRecoveryGroupInfo: Decodable {
            let publicKey: String
            let commitments: [String]
        }
        try assertKeyNotFound(
            LegacyRecoveryGroupInfo.self, in: try payload("recoveryGroupInfo"), expecting: "publicKey",
            "the server's key is groupPublicKey; publicKey was never sent"
        )
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
}
