import Foundation
import XCTest
@testable import Llamenos

/// Regression coverage for platform bans on iOS (#2759): creating one, and promoting a hub ban
/// to platform scope (`AdminViewModel.promoteBanToPlatform(banId:sourceHubId:phone:)`).
///
/// Promote was silently deleted once inside a type-migration refactor (PR #1546) and nothing
/// failed, because an unreferenced method compiles clean; the signature check below makes its
/// absence a build failure of the test target.
///
/// Both flows must never put the number on the wire. The client blinds it in the crate, the
/// server evaluates the blinded element (`/api/admin/bans/evaluate` or `/search/evaluate`), and
/// the crate finalizes the answer into the ban digest the body carries. The mock server here
/// "evaluates" by echoing the blinded element back — a valid group element, so the real crate
/// finalizes it — which is enough to pin every request's shape and to prove that no request
/// body anywhere contains the typed number.
@MainActor
final class AdminViewModelPromoteBanTests: XCTestCase {

    private let testBaseURL = URL(string: "https://hub.example.org")!
    private let phone = "+15550100042"

    /// Compile-time existence check: deleting or renaming the capability, or
    /// changing its signature, stops this file from building.
    func testPromoteBanToPlatformExistsWithBanIdHubAndPhoneSignature() {
        let promote: (AdminViewModel) -> (String, String, String) async -> Void = AdminViewModel.promoteBanToPlatform
        XCTAssertNotNil(promote)
    }

    func testPromoteSendsTheSourceHubAndPlatformDigestsAndNeverTheNumber() async throws {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }
        MockURLProtocol.requestHandler = { request in
            switch request.url?.path {
            case "/api/admin/bans/search/evaluate":
                let element = Self.lastJSON()?["blindedElement"] as? String ?? ""
                return (200, Data(#"{"evaluations":[{"evaluatedElement":"\#(element)"},{"hubId":"hub-1","evaluatedElement":"\#(element)"}]}"#.utf8))
            case "/api/admin/bans":
                return (200, Data(#"{"bans":[],"total":0}"#.utf8))
            default:
                return (200, Data(#"{"ok":true}"#.utf8))
            }
        }

        let viewModel = makeViewModel()
        await viewModel.promoteBanToPlatform(banId: "ban-42", sourceHubId: "hub-1", phone: phone)

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.successMessage, "a successful promote reports success")

        let paths = MockURLProtocol.capturedRequests.map { $0.url?.path ?? "" }
        let promoteIndex = try XCTUnwrap(paths.firstIndex(of: "/api/admin/bans/promote"))
        XCTAssertEqual(MockURLProtocol.capturedRequests[promoteIndex].httpMethod, "POST")
        let body = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: MockURLProtocol.capturedBodies[promoteIndex]) as? [String: Any]
        )
        // promoteBanBodySchema: {banId, sourcePhoneHash, phoneHash} — two 128-hex ban digests.
        XCTAssertEqual(Set(body.keys), ["banId", "sourcePhoneHash", "phoneHash"], "got \(body)")
        XCTAssertEqual(body["banId"] as? String, "ban-42")
        XCTAssertEqual((body["phoneHash"] as? String)?.count, 128)
        XCTAssertEqual((body["sourcePhoneHash"] as? String)?.count, 128)

        assertNumberNeverSent()
    }

    func testAddPlatformBanSendsOnlyTheDigest() async throws {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }
        MockURLProtocol.requestHandler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/api/admin/bans/evaluate"):
                let elements = Self.lastJSON()?["blindedElements"] as? [String] ?? []
                let echoed = elements.map { "\"\($0)\"" }.joined(separator: ",")
                return (200, Data(#"{"evaluatedElements":[\#(echoed)]}"#.utf8))
            case ("GET", "/api/admin/bans"):
                return (200, Data(#"{"bans":[],"total":0}"#.utf8))
            default:
                return (200, Data(#"{"ok":true}"#.utf8))
            }
        }

        let viewModel = makeViewModel()
        viewModel.newPlatformBanPhone = phone
        viewModel.newBanReason = "coordinated abuse"
        await viewModel.addPlatformBan()

        XCTAssertNil(viewModel.errorMessage)
        let index = try XCTUnwrap(MockURLProtocol.capturedRequests.firstIndex {
            $0.httpMethod == "POST" && $0.url?.path == "/api/admin/bans"
        })
        let body = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: MockURLProtocol.capturedBodies[index]) as? [String: Any]
        )
        // createPlatformBanBodySchema: {phoneHash, reason?}.
        XCTAssertEqual(Set(body.keys), ["phoneHash", "reason"], "got \(body)")
        XCTAssertEqual((body["phoneHash"] as? String)?.count, 128)
        assertNumberNeverSent()
    }

    func testAddPlatformBanRefusesANumberThatIsNotE164() async {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }
        MockURLProtocol.requestHandler = { _ in (200, Data(#"{"ok":true}"#.utf8)) }

        let viewModel = makeViewModel()
        viewModel.newPlatformBanPhone = "555 0100"
        await viewModel.addPlatformBan()

        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty, "nothing is sent for a malformed number")
    }

    func testPromoteBanToPlatformSurfacesServerRejection() async {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }

        // 409 = "Ban is already platform-scoped" (apps/worker/routes/platform-bans.ts).
        MockURLProtocol.requestHandler = { _ in
            (409, Data(#"{"error":"Ban is already platform-scoped"}"#.utf8))
        }

        let viewModel = makeViewModel()
        await viewModel.promoteBanToPlatform(banId: "ban-already-platform", sourceHubId: "hub-1", phone: phone)

        XCTAssertNotNil(viewModel.errorMessage, "a rejected promote must not look successful")
        XCTAssertNil(viewModel.successMessage)
    }

    // MARK: - Helpers

    private nonisolated static func lastJSON() -> [String: Any]? {
        guard let data = MockURLProtocol.capturedBodies.last else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func assertNumberNeverSent(file: StaticString = #filePath, line: UInt = #line) {
        let digits = String(phone.dropFirst())
        for body in MockURLProtocol.capturedBodies {
            let text = String(decoding: body, as: UTF8.self)
            XCTAssertFalse(text.contains(digits), "a request body carried the number: \(text)", file: file, line: line)
        }
        for request in MockURLProtocol.capturedRequests {
            XCTAssertFalse(
                request.url?.absoluteString.contains(digits) ?? false,
                "a request URL carried the number", file: file, line: line
            )
        }
    }

    private func makeViewModel() -> AdminViewModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let cryptoService = CryptoService()
        let apiService = APIService(
            cryptoService: cryptoService,
            hubContext: HubContext(),
            sessionConfiguration: config
        )
        apiService.configure(baseURL: testBaseURL)
        return AdminViewModel(apiService: apiService, cryptoService: cryptoService)
    }
}
