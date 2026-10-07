import Foundation
import XCTest
@testable import Llamenos

/// What `APIService` actually puts on the wire.
///
/// These assert the *serialized bytes* of production's own encoder
/// (`APIService.makeEncoder()`), never a request object's Swift properties. That
/// distinction is the whole point: `DeviceRegistrationRequest` declares
/// `pushToken`/`wakeKeyPublic`, so every in-language assertion about it passed
/// while the encoder's `.convertToSnakeCase` rewrote them to
/// `push_token`/`wake_key_public` on the way out. The server's
/// `registerDeviceBodySchema` (packages/protocol/schemas/devices.ts) is camelCase
/// and non-strict, so it dropped all three as unknown keys, both `.refine()`s
/// failed, and `POST /api/devices/register` answered 400 on every launch —
/// swallowed as "non-fatal" in `LlamenosApp`, leaving the `devices` table empty
/// for the client's entire history.
///
/// Captured from a live run of the real client against a live server:
///
///     >>> POST /api/devices/register -> 400
///         REQ  {"device_id":"…","push_token":"…","wake_key_public":"…","platform":"ios"}
///         RESP {"error":[{"message":"Provide pushToken (to register for push) or
///                x25519Pubkey (to register this device as an HPKE recipient)"}]}
final class APIServiceWireFormatTests: XCTestCase {

    /// Keys as they appear in the JSON `APIService` would send.
    private func wireKeys(_ value: some Encodable) throws -> Set<String> {
        let data = try APIService.makeEncoder().encode(value)
        let object = try JSONSerialization.jsonObject(with: data)
        let dict = try XCTUnwrap(object as? [String: Any], "encoded body is not a JSON object")
        return Set(dict.keys)
    }

    /// The exact body that answered 400 on every launch.
    func testDeviceRegistrationSendsTheKeysTheServerSchemaRequires() throws {
        let keys = try wireKeys(DeviceRegistrationRequest(
            pushToken: String(repeating: "a", count: 64),
            wakeKeyPublic: String(repeating: "b", count: 64),
            platform: "ios",
            deviceId: "D1"
        ))
        // registerDeviceBodySchema's two .refine()s read `pushToken` and
        // `wakeKeyPublic`. Under .convertToSnakeCase neither key existed.
        XCTAssertTrue(keys.contains("pushToken"), "server reads `pushToken`; sent \(keys.sorted())")
        XCTAssertTrue(keys.contains("wakeKeyPublic"), "server reads `wakeKeyPublic`; sent \(keys.sorted())")
        XCTAssertFalse(keys.contains("push_token"), "snake_case is dropped as an unknown key")
        XCTAssertFalse(keys.contains("wake_key_public"), "snake_case is dropped as an unknown key")
    }

    /// The defect was never specific to one request — it was the encoder, so it
    /// applied to every multi-word field the client has ever sent.
    func testEncoderDoesNotRewriteMultiWordKeys() throws {
        struct Probe: Encodable { let hubId = "h1"; let roleIds = ["role-volunteer"]; let x25519Pubkey = "pk" }
        XCTAssertEqual(try wireKeys(Probe()), ["hubId", "roleIds", "x25519Pubkey"])
    }

    /// The decoder is deliberately NOT part of the fix: a camelCase key has no
    /// underscores, so `.convertFromSnakeCase` passes it through untouched. This
    /// pins the property the client actually relies on, so that "the encoder
    /// changed, change the decoder to match" cannot quietly become a behaviour
    /// change nothing observed.
    func testDecoderReadsCamelCaseResponseKeys() throws {
        struct Probe: Decodable, Equatable { let hubId: String; let createdAt: String }
        let json = Data(#"{"hubId":"h1","createdAt":"2026-01-01"}"#.utf8)
        let decoded = try APIService.makeDecoder().decode(Probe.self, from: json)
        XCTAssertEqual(decoded, Probe(hubId: "h1", createdAt: "2026-01-01"))
    }

    /// `POST /api/security-events` is the one endpoint whose schema really is
    /// snake_case (`z.strictObject` in
    /// `apps/worker/schemas/client-security-events.ts`), and it is also `strict`,
    /// so camelCase there would be REJECTED rather than ignored. It is uploaded by
    /// `SecurityEventService` through its own session and its own encoder.
    ///
    /// This asserts the two encoders stay distinct. Without it, the obvious
    /// follow-up tidy — "there are two JSONEncoders, unify them" — silently breaks
    /// certificate-pin-mismatch reporting, the one report that must survive an
    /// active MITM.
    func testSecurityEventUploadKeepsItsOwnSnakeCaseEncoder() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // Unit
            .deletingLastPathComponent()      // Tests
            .deletingLastPathComponent()      // apps/ios
            .appendingPathComponent("Sources/Services/SecurityEventService.swift"), encoding: .utf8)
        XCTAssertTrue(
            source.contains("keyEncodingStrategy = .convertToSnakeCase"),
            "SecurityEventService must keep its own snake_case encoder — "
            + "POST /api/security-events uses z.strictObject with snake_case keys"
        )
        XCTAssertFalse(
            source.contains("APIService.makeEncoder()"),
            "SecurityEventService must not adopt the shared camelCase encoder"
        )
    }
}
