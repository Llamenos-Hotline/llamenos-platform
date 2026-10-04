import Foundation
import XCTest
@testable import Llamenos

/// `APIService.resolve(path:against:)`: a query string must reach the server as a
/// query, and the auth token must sign the path the server verifies (`url.pathname`
/// in apps/worker/lib/auth.ts). Before it existed, `appendingPathComponent` turned
/// "?" into "%3F" and the token signed the query too, so every request with a query
/// string — notes, cases, contacts, reports, events, call history, audit log —
/// failed with 401 (the CI backend log: `GET /api/hubs/…/notes%3Fpage=1&limit=3` →
/// `signature_verification_failed`).
final class APIServiceURLTests: XCTestCase {

    private let base = URL(string: "https://hub.example.org")!

    func testQueryStringStaysAQuery() throws {
        let target = try APIService.resolve(path: "/api/hubs/h1/notes?page=1&limit=3", against: base)
        XCTAssertEqual(target.url.absoluteString, "https://hub.example.org/api/hubs/h1/notes?page=1&limit=3")
        XCTAssertEqual(target.url.path, "/api/hubs/h1/notes")
        XCTAssertEqual(target.url.query, "page=1&limit=3")
    }

    func testTokenSignsThePathTheServerVerifies() throws {
        let target = try APIService.resolve(path: "/api/notes?page=2&limit=20", against: base)
        XCTAssertEqual(target.signedPath, "/api/notes")
        XCTAssertEqual(target.signedPath, target.url.path)
    }

    func testPathWithoutQueryIsUnchanged() throws {
        let target = try APIService.resolve(path: "/api/hubs/h1/shifts", against: base)
        XCTAssertEqual(target.url.absoluteString, "https://hub.example.org/api/hubs/h1/shifts")
        XCTAssertNil(target.url.query)
        XCTAssertEqual(target.signedPath, "/api/hubs/h1/shifts")
    }

    func testUserInputInTheQueryStaysInTheQuery() throws {
        let target = try APIService.resolve(path: "/api/contacts/search?q=ana maria#1", against: base)
        XCTAssertEqual(target.url.path, "/api/contacts/search")
        let items = URLComponents(url: target.url, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(items?.first?.name, "q")
        XCTAssertEqual(items?.first?.value, "ana maria#1")
    }
}
