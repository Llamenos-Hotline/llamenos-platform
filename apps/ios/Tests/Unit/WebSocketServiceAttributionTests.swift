import Foundation
import Testing
@testable import Llamenos

// MARK: - WebSocketService Decryption & Attribution Tests

/// Tests for `WebSocketService.decryptPayload(_:epoch:hubId:)`.
///
/// The core invariant: `decryptPayload` returns an `AttributedHubEvent` whose `hubId`
/// matches the hub ID passed in from the server message (new protocol — hub is not inferred
/// from key-trial, it is provided directly in the event envelope).
///
/// Real decryption happens in Rust via `CryptoService.openServerEvent`, under the per-hub event key the crate holds (#2999).
/// These tests use `WebSocketService.decryptionHandler` — a `#if DEBUG` closure that
/// overrides the CryptoService call — to return predetermined plaintext JSON without
/// requiring actual encrypted payloads or stored server event keys.
@MainActor
struct WebSocketServiceAttributionTests {

    // MARK: - Helpers

    /// Create a `WebSocketService` with a mock decryption closure that returns a fixed
    /// JSON string for any (ciphertext, epoch) pair, simulating successful decryption.
    private func makeService(
        json: String = #"{"type":"call:ring","callSid":"CA123"}"#
    ) -> WebSocketService {
        let ws = WebSocketService(cryptoService: CryptoService())
        ws.decryptionHandler = { _, _ in json }
        return ws
    }

    // MARK: - Attribution Tests

    /// `decryptPayload` attributes the event to the hub ID provided in the call.
    @Test func testDecryptPayloadAttributesToPassedHub() {
        let ws = makeService(json: #"{"type":"shift:update"}"#)

        let result = ws.decryptPayload("opaque-ciphertext", epoch: 1, hubId: "hub-2")
        #expect(result != nil)
        #expect(result?.hubId == "hub-2")
        #expect(result?.event == .shiftUpdate)
    }

    /// `decryptPayload` returns `nil` when decryption fails (mock returns nil).
    @Test func testDecryptPayloadReturnsNilWhenDecryptionFails() {
        let ws = WebSocketService(cryptoService: CryptoService())
        ws.decryptionHandler = { _, _ in nil }

        let result = ws.decryptPayload("opaque-ciphertext", epoch: 1, hubId: "hub-1")
        #expect(result == nil)
    }

    /// `decryptPayload` returns `nil` when no server event key is loaded and no mock is set.
    @Test func testDecryptPayloadReturnsNilWithNoKeyLoaded() {
        let ws = WebSocketService(cryptoService: CryptoService())
        // decryptionHandler defaults to { _, _ in nil }; no Rust server key loaded.

        let result = ws.decryptPayload("opaque-ciphertext", epoch: 1, hubId: "hub-1")
        #expect(result == nil)
    }

    /// `decryptPayload` parses a voicemail:new event type correctly.
    @Test func testDecryptPayloadParsesVoicemailNewType() {
        let ws = makeService(json: #"{"type":"voicemail:new"}"#)

        let result = ws.decryptPayload("opaque-ciphertext", epoch: 42, hubId: "winner-hub")
        #expect(result != nil)
        #expect(result?.hubId == "winner-hub")
        #expect(result?.event == .voicemailNew)
    }

    /// `decryptPayload` correctly routes `call:answered` events.
    @Test func testDecryptPayloadParsesCallAnsweredType() {
        let ws = makeService(json: #"{"type":"call:answered","callSid":"CA999"}"#)

        let result = ws.decryptPayload("encrypted-blob", epoch: 7, hubId: "hub-answered")
        #expect(result != nil)
        #expect(result?.event == .callAnswered)
    }

    /// `decryptPayload` correctly routes `presence:detail` events.
    @Test func testDecryptPayloadParsesPresenceDetailType() {
        let ws = makeService(json: #"{"type":"presence:detail","available":3,"onCall":1,"total":4}"#)

        let result = ws.decryptPayload("enc-payload", epoch: 0, hubId: "hub-alpha")
        #expect(result != nil)
        #expect(result?.event == .presenceDetail)
    }

    /// `decryptPayload` correctly routes `conversation:new` events.
    @Test func testDecryptPayloadParsesConversationNewType() {
        let ws = makeService(json: #"{"type":"conversation:new","conversationId":"conv-1"}"#)

        let result = ws.decryptPayload("enc-payload", epoch: 0, hubId: "hub-alpha")
        #expect(result != nil)
        #expect(result?.event == .conversationNew)
    }

    /// `decryptPayload` correctly routes `message:status` events.
    @Test func testDecryptPayloadParsesMessageStatusType() {
        let ws = makeService(json: #"{"type":"message:status","messageId":"msg-1","status":"delivered"}"#)

        let result = ws.decryptPayload("enc-payload", epoch: 0, hubId: "hub-alpha")
        #expect(result != nil)
        #expect(result?.event == .messageStatus)
    }

    /// Unknown event type strings map to `.unknown` rather than nil.
    @Test func testDecryptPayloadMapsUnknownTypeToUnknownCase() {
        let ws = makeService(json: #"{"type":"future:event:type"}"#)

        let result = ws.decryptPayload("enc", epoch: 0, hubId: "h")
        #expect(result != nil)
        #expect(result?.event == .unknown)
    }
}
