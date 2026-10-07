import Foundation
import XCTest
@testable import Llamenos

/// Records the body of every request and answers 200 `{}`.
private final class BodyCaptureURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var bodies: [Data] = []

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        bodies = []
    }

    static func lastBodyJSON() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let body = try XCTUnwrap(bodies.last, "APIService sent no request body")
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // URLSession hands a protocol the body as a stream, not `httpBody`.
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                guard read > 0 else { break }
                body.append(buffer, count: read)
            }
        }
        Self.lock.lock()
        Self.bodies.append(body)
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private struct Empty: Decodable {}

/// `APIService` must send request bodies with the keys the server's schema names
/// (packages/protocol/schemas — camelCase throughout). It used to encode with
/// `convertToSnakeCase`, so `POST /notes` went out as `encrypted_content` and the
/// server answered 400: no iOS note could be saved (#1293). Dictionary bodies were
/// rewritten too (`hubId` → `hub_id`).
final class APIServiceWireFormatTests: XCTestCase {

    private var api: APIService!

    override func setUpWithError() throws {
        BodyCaptureURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [BodyCaptureURLProtocol.self]
        api = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)
        try api.configure(hubURLString: "https://hub.example.org")
    }

    func testCreateNoteBodyGoesOutWithTheSchemaKeys() async throws {
        let body = CreateNoteBody(
            adminEnvelopes: [SharedAdminEnvelope(ct: "ct-admin", enc: "enc-admin", pubkey: "pk-admin")],
            authorEnvelope: SharedAuthorEnvelope(ct: "ct-author", enc: "enc-author"),
            callID: "call-1",
            caseID: nil,
            contactHash: nil,
            conversationID: nil,
            encryptedContent: "deadbeef",
            interactionTypeHash: nil
        )
        let _: Empty = try await api.request(method: "POST", path: "/api/hubs/h1/notes", body: body)

        let json = try BodyCaptureURLProtocol.lastBodyJSON()
        XCTAssertEqual(
            Set(json.keys), ["adminEnvelopes", "authorEnvelope", "callId", "encryptedContent"],
            "POST /notes must carry the createNoteBodySchema keys, and nothing snake_cased"
        )
        XCTAssertEqual(json["encryptedContent"] as? String, "deadbeef")
        XCTAssertEqual(json["callId"] as? String, "call-1")
    }

    func testDictionaryBodyKeysAreSentVerbatim() async throws {
        let body: [String: String] = ["hubId": "h1", "field_name": "x"]
        let _: Empty = try await api.request(method: "POST", path: "/api/recovery-group/shares/liveness", body: body)

        let json = try BodyCaptureURLProtocol.lastBodyJSON()
        XCTAssertEqual(Set(json.keys), ["hubId", "field_name"])
    }
}
