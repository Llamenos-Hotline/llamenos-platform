import XCTest
@testable import Llamenos

/// Unit tests for `InviteCodeParser` (#1046) — the normalization rules must
/// stay byte-identical with Android's `InviteCodeParser` in
/// `InviteModels.kt`, since a volunteer may paste the same invite link into
/// either client.
final class InviteCodeParserTests: XCTestCase {
    private let bareCode = "3f6f1a2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b"

    func testExtractCodeFromBareUUID() {
        XCTAssertEqual(InviteCodeParser.extractCode(bareCode), bareCode)
    }

    func testExtractCodeFromInviteLink() {
        let link = "https://hub.example.org/onboarding?code=\(bareCode)"
        XCTAssertEqual(InviteCodeParser.extractCode(link), bareCode)
    }

    func testExtractCodeNormalizesToLowercase() {
        XCTAssertEqual(
            InviteCodeParser.extractCode(bareCode.uppercased()),
            bareCode
        )
    }

    func testExtractCodeTrimsWhitespace() {
        XCTAssertEqual(InviteCodeParser.extractCode("  \(bareCode)\n"), bareCode)
    }

    func testExtractCodeRejectsGarbage() {
        XCTAssertNil(InviteCodeParser.extractCode("not-a-real-code"))
        XCTAssertNil(InviteCodeParser.extractCode(""))
        XCTAssertNil(InviteCodeParser.extractCode("123e4567-e89b-12d3")) // too short
    }

    func testExtractHubURLFromInviteLink() {
        let link = "https://hub.example.org/onboarding?code=\(bareCode)"
        XCTAssertEqual(InviteCodeParser.extractHubURL(link), "https://hub.example.org")
    }

    func testExtractHubURLPreservesNonDefaultPort() {
        let link = "https://127.0.0.1:3000/onboarding?code=\(bareCode)"
        XCTAssertEqual(InviteCodeParser.extractHubURL(link), "https://127.0.0.1:3000")
    }

    func testExtractHubURLRejectsBareCodeAndHTTP() {
        XCTAssertNil(InviteCodeParser.extractHubURL(bareCode))
        // Desktop invite links are https; an http origin would fail the H6
        // secure-connection guard anyway, so the parser does not hand it over.
        XCTAssertNil(InviteCodeParser.extractHubURL("http://hub.example.org/onboarding?code=\(bareCode)"))
    }
}
