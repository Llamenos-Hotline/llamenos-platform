import Foundation
import XCTest
@testable import Llamenos

/// A fake server that mirrors the worker's contract for `POST …/conversations/:id/messages`
/// (apps/worker/routes/conversations.ts): an external-channel send without
/// `plaintextForSending` is refused 422 and NOTHING is stored; a send with it is handed to
/// the (recorded) carrier and stored with the status the carrier answered.
private final class ReplyServerStubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var _bodies: [[String: Any]] = []
    private static var _handedToCarrier: [String] = []
    private static var _stored: [[String: Any]] = []
    private static var _carrierOutcome = "sent"

    static func reset(carrierOutcome: String = "sent") {
        lock.lock(); defer { lock.unlock() }
        _bodies = []; _handedToCarrier = []; _stored = []; _carrierOutcome = carrierOutcome
    }
    /// Every POST body the client sent, decoded.
    static var postBodies: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return _bodies }
    /// What the carrier behind the route was handed.
    static var handedToCarrier: [String] { lock.lock(); defer { lock.unlock() }; return _handedToCarrier }
    static var stored: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return _stored }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "reply-delivery.test"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private func respond(_ status: Int, _ json: Any) {
        let data = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    private func bodyData() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        guard path.hasSuffix("/messages") else { return respond(404, ["error": "Not Found"]) }

        if method == "GET" {
            Self.lock.lock(); let rows = Self._stored; Self.lock.unlock()
            return respond(200, ["messages": rows, "total": rows.count, "page": 1, "limit": 50])
        }

        let body = (try? JSONSerialization.jsonObject(with: bodyData())) as? [String: Any] ?? [:]
        Self.lock.lock(); Self._bodies.append(body); Self.lock.unlock()

        let plaintext = (body["plaintextForSending"] as? String) ?? ""
        guard !plaintext.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return respond(422, [
                "error": "plaintextForSending is required to send on an external channel",
                "code": "plaintext_for_sending_required",
            ])
        }
        Self.lock.lock()
        Self._handedToCarrier.append(plaintext)
        var row: [String: Any] = [
            "id": "msg-out-1", "conversationId": "conv-1", "direction": "outbound",
            "encryptedContent": body["encryptedContent"] as? String ?? "",
            "readerEnvelopes": body["readerEnvelopes"] ?? [],
            "createdAt": "2026-10-20T10:06:00.000Z", "status": Self._carrierOutcome,
        ]
        if Self._carrierOutcome == "failed" { row["failureReason"] = "Provider error" }
        Self._stored.append(row)
        Self.lock.unlock()
        respond(201, row)
    }
    override func stopLoading() {}
}

/// A reply to an SMS / WhatsApp / Signal conversation must reach the carrier (#2500).
///
/// The server keeps no plaintext, so an outbound message carries the sealed copy for the
/// hub's readers AND the plaintext the carrier transmits. iOS sent only the first: the reply
/// was stored `pending` and handed to no provider while the volunteer believed they had
/// answered someone in crisis. These tests drive the real view model and a real
/// `CryptoService` against a fake server that refuses what the real one refuses.
@MainActor
final class ConversationReplyDeliveryTests: XCTestCase {

    private func makeViewModel() async throws -> ConversationsViewModel {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReplyServerStubURLProtocol.self]
        let crypto = CryptoService()
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        let hubContext = HubContext()
        hubContext.setActiveHub("hub-a")
        let api = APIService(cryptoService: crypto, hubContext: hubContext, sessionConfiguration: configuration)
        try api.configure(hubURLString: "https://reply-delivery.test")
        let vm = ConversationsViewModel(
            apiService: api,
            cryptoService: crypto,
            webSocketService: WebSocketService(cryptoService: crypto),
            hubContext: hubContext,
            adminPubkeys: [String(repeating: "ab", count: 32)]
        )
        // Scopes the view model to the active hub, as opening the thread does.
        await vm.loadMessages(for: "conv-1")
        return vm
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    func testAReplyCarriesTheSealedCopyAndThePlaintextAndTheCarrierIsHandedTheText() async throws {
        ReplyServerStubURLProtocol.reset()
        let vm = try await makeViewModel()
        vm.replyText = "We hear you. Help is on the way."

        await vm.sendReply()

        let sent = try XCTUnwrap(ReplyServerStubURLProtocol.postBodies.first, "no reply reached the server")
        XCTAssertFalse((sent["encryptedContent"] as? String ?? "").isEmpty, "the sealed copy is missing")
        XCTAssertFalse((sent["readerEnvelopes"] as? [Any] ?? []).isEmpty, "the sealed copy has no envelopes")
        XCTAssertEqual(sent["plaintextForSending"] as? String, "We hear you. Help is on the way.")
        // What the carrier behind the route received — not merely that a call was made.
        XCTAssertEqual(ReplyServerStubURLProtocol.handedToCarrier, ["We hear you. Help is on the way."])
        XCTAssertNil(vm.sendErrorMessage, "a delivered reply must not show a send error")
        XCTAssertEqual(vm.replyText, "")
    }

    func testAReplyTheCarrierRejectedIsShownAsFailedNotAsSent() async throws {
        ReplyServerStubURLProtocol.reset(carrierOutcome: "failed")
        let vm = try await makeViewModel()
        vm.replyText = "We hear you."

        await vm.sendReply()

        let row = try XCTUnwrap(vm.currentMessages.first, "the stored reply must be in the thread")
        guard case .readable(let message) = row else {
            return XCTFail("the sender's own reply must be readable on this device")
        }
        XCTAssertTrue(message.isOutbound)
        XCTAssertTrue(message.deliveryFailed, "the provider never took this reply; the thread must say so")
    }

    func testABlankReplyIsNeverSent() async throws {
        ReplyServerStubURLProtocol.reset()
        let vm = try await makeViewModel()
        vm.replyText = "   "   // blank: never leaves the device, so the server never has to refuse it

        await vm.sendReply()

        XCTAssertTrue(ReplyServerStubURLProtocol.postBodies.isEmpty, "a blank reply must not be sent")
        XCTAssertTrue(ReplyServerStubURLProtocol.stored.isEmpty)
    }
}
