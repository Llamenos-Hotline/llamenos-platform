import Foundation
import XCTest
@testable import Llamenos

/// Loads `/api/telephony/sip-token` payloads from `apps/ios/Tests/Wire/sip-token-response.json`.
///
/// Every `SipTokenResponse` in this suite comes from here rather than from a Swift
/// initialiser, and that is deliberate. Constructing the model in Swift is what let #1659
/// ship: `LinphoneServiceTests` and `ShiftViewModelLinphoneTests` built
/// `SipTokenResponse(username:domain:password:transport:expiry:)` and exercised the
/// registration logic perfectly against a value the server could never produce, so they
/// confirmed the broken model instead of catching it. A loader means a model that stops
/// matching the server's bytes breaks every test that touches a token, not just the
/// decode test.
///
/// The fixture itself is checked against the real Zod response schema on the backend unit
/// tier (`apps/worker/__tests__/unit/sip-token-wire-body.test.ts`), which — unlike an iOS
/// test (#1584) — runs on every pull request.
enum SipTokenFixture {
    private static var fixtureURL: URL? {
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/Unit
            .deletingLastPathComponent()   // Tests
        let candidate = dir.appendingPathComponent("Wire/sip-token-response.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        for _ in 0..<3 {
            dir = dir.deletingLastPathComponent()
            let alt = dir.appendingPathComponent("apps/ios/Tests/Wire/sip-token-response.json")
            if FileManager.default.fileExists(atPath: alt.path) { return alt }
        }
        return nil
    }

    /// The raw bytes recorded for `id`.
    static func bytes(_ id: String) throws -> Data {
        guard let url = fixtureURL else {
            throw XCTSkip("sip-token-response.json not reachable; run from a source checkout")
        }
        let root = try JSONSerialization.jsonObject(with: try Data(contentsOf: url))
        guard let dict = root as? [String: Any],
              let responses = dict["responses"] as? [String: Any],
              let one = responses[id]
        else {
            throw NSError(
                domain: "SipTokenFixture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "sip-token-response.json has no responses.\(id)"]
            )
        }
        return try JSONSerialization.data(withJSONObject: one, options: [.sortedKeys])
    }

    /// `id` decoded through the production response decoder.
    static func token(_ id: String = "sipTokenWithTurn") throws -> SipTokenResponse {
        try APIService.makeResponseDecoder().decode(SipTokenResponse.self, from: try bytes(id))
    }
}
