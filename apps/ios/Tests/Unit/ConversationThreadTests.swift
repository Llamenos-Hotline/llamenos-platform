import Foundation
import Testing
@testable import Llamenos

/// The conversation thread must say what this device can and cannot read, and offer Claim
/// and Reply from permissions the server also enforces (#2202).
@MainActor
@Suite("Conversation thread")
struct ConversationThreadTests {
    private static let device = String(repeating: "ab", count: 32)
    private static let other = String(repeating: "cd", count: 32)

    private struct DecryptFailure: Error {}

    private func message(id: String = "m1", envelopePubkeys: [String]) throws -> ConversationMessage {
        let envelopes = envelopePubkeys.map { ["pubkey": $0, "enc": "e", "ct": "c"] }
        let json: [String: Any] = [
            "id": id, "conversationId": "c1", "direction": "inbound",
            "encryptedContent": "cipher", "readerEnvelopes": envelopes,
            "createdAt": "2026-10-25T10:00:00.000Z",
        ]
        return try JSONDecoder().decode(
            ConversationMessage.self, from: JSONSerialization.data(withJSONObject: json)
        )
    }

    private func conversation(
        channel: String = "sms", status: String = "waiting", assignedTo: String? = nil
    ) throws -> AppConversation {
        var json: [String: Any] = [
            "id": "c1", "channelType": channel, "contactIdentifierHash": "deadbeefdeadbeef",
            "status": status, "createdAt": "2026-10-25T10:00:00.000Z",
        ]
        if let assignedTo { json["assignedTo"] = assignedTo }
        return try JSONDecoder().decode(
            AppConversation.self, from: JSONSerialization.data(withJSONObject: json)
        )
    }

    // MARK: - Unreadable messages stay in the thread

    @Test func aMessageWithNoEnvelopeForThisDeviceIsAnExplicitUnreadableRow() throws {
        let row = ThreadMessage(
            try message(envelopePubkeys: [Self.other]), devicePubkey: Self.device
        ) { _ in Issue.record("must not try to open an envelope that is not ours"); return "" }

        guard case .unreadable(let unreadable) = row else {
            Issue.record("expected an unreadable row"); return
        }
        #expect(unreadable.reason == .noEnvelopeForThisDevice)
        #expect(unreadable.id == "m1")
    }

    @Test func aMessageWithNoEnvelopesAtAllIsUnreadableNotDropped() throws {
        let row = ThreadMessage(try message(envelopePubkeys: []), devicePubkey: Self.device) { _ in "x" }
        guard case .unreadable(let unreadable) = row else {
            Issue.record("expected an unreadable row"); return
        }
        #expect(unreadable.reason == .noEnvelopeForThisDevice)
    }

    @Test func anEnvelopeForThisDeviceThatDoesNotOpenIsADecryptionFailure() throws {
        let row = ThreadMessage(
            try message(envelopePubkeys: [Self.other, Self.device]), devicePubkey: Self.device
        ) { _ in throw DecryptFailure() }

        guard case .unreadable(let unreadable) = row else {
            Issue.record("expected an unreadable row"); return
        }
        #expect(unreadable.reason == .decryptionFailed)
    }

    @Test func aMessageSealedToThisDeviceIsReadable() throws {
        let row = ThreadMessage(
            try message(envelopePubkeys: [Self.device.uppercased()]), devicePubkey: Self.device
        ) { _ in "hello" }

        guard case .readable(let readable) = row else {
            Issue.record("expected a readable row"); return
        }
        #expect(readable.text == "hello")
    }

    @Test func withNoDeviceKeyLoadedNothingIsClaimedReadable() throws {
        let row = ThreadMessage(try message(envelopePubkeys: [Self.device]), devicePubkey: nil) { _ in "x" }
        guard case .unreadable = row else { Issue.record("expected an unreadable row"); return }
    }

    // MARK: - Claim

    @Test func claimIsOfferedOnAWaitingConversationToTheChannelClaimPermission() throws {
        let sms = try conversation(channel: "sms")
        #expect(ConversationAccess.canClaim(sms) { $0 == "conversations:claim-sms" })
        #expect(!ConversationAccess.canClaim(sms) { $0 == "conversations:claim-whatsapp" })
    }

    @Test func claimAnyAndWildcardsGrantClaimOnEveryChannel() throws {
        let signal = try conversation(channel: "signal")
        #expect(ConversationAccess.canClaim(signal) { $0 == "conversations:claim-any" })
        // Domain and global wildcards, as `PermissionService` resolves them.
        #expect(ConversationAccess.canClaim(signal) {
            PermissionService.permissionGranted(["conversations:*"], required: $0)
        })
        #expect(ConversationAccess.canClaim(signal) {
            PermissionService.permissionGranted(["*"], required: $0)
        })
    }

    @Test func claimIsNotOfferedWithoutPermissionOrOnAConversationThatIsNotWaiting() throws {
        #expect(!ConversationAccess.canClaim(try conversation()) { _ in false })
        #expect(!ConversationAccess.canClaim(try conversation(status: "active", assignedTo: Self.device)) { _ in true })
        #expect(!ConversationAccess.canClaim(try conversation(status: "closed")) { _ in true })
        #expect(!ConversationAccess.canClaim(try conversation(assignedTo: Self.other)) { _ in true })
    }

    // MARK: - Reply

    @Test func replyIsNotEnabledOnAWaitingConversationBeforeItIsClaimed() throws {
        let waiting = try conversation()
        #expect(!ConversationAccess.canReply(waiting, userPubkey: Self.device) { $0.hasPrefix("conversations:claim") })
    }

    @Test func replyIsEnabledForTheAssigneeAndForSendAny() throws {
        let mine = try conversation(status: "active", assignedTo: Self.device)
        #expect(ConversationAccess.canReply(mine, userPubkey: Self.device) { _ in false })
        let theirs = try conversation(status: "active", assignedTo: Self.other)
        #expect(!ConversationAccess.canReply(theirs, userPubkey: Self.device) { _ in false })
        #expect(ConversationAccess.canReply(theirs, userPubkey: Self.device) { $0 == "conversations:send-any" })
    }
}
