import Foundation
import XCTest
@testable import Llamenos

/// Regression coverage for the admin "promote a hub-scoped ban to platform
/// scope" capability (`AdminViewModel.promoteBanToPlatform(banId:)`).
///
/// This capability was silently deleted once inside a type-migration refactor
/// (PR #1546) and nothing failed, because an unreferenced method compiles clean.
/// These tests make its absence a build failure of the test target, and pin the
/// endpoint and wire body so a regression to the wrong route fails loudly:
/// an earlier implementation posted `{identifierHash, reason}` to
/// `POST /api/bans/platform`, whose validator is `createPlatformBanBodySchema`
/// (`{phone: <E.164>, reason?}`) — every call would have 400'd. The real route
/// is `POST /api/bans/platform/promote` with `promoteBanBodySchema` (`{banId}`).
final class AdminViewModelPromoteBanTests: XCTestCase {

    private let testBaseURL = URL(string: "https://hub.example.org")!

    /// Compile-time existence check: deleting or renaming the capability, or
    /// changing its signature, stops this file from building.
    func testPromoteBanToPlatformExistsWithBanIdSignature() {
        let promote: (AdminViewModel) -> (String) async -> Void = AdminViewModel.promoteBanToPlatform
        XCTAssertNotNil(promote)
    }

    func testPromoteBanToPlatformPostsBanIdToPromoteEndpoint() async throws {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }

        MockURLProtocol.requestHandler = { request in
            // The follow-up platform-ban reload must not fail the promote path.
            if request.url?.path == "/api/bans/platform" {
                return (200, Data(#"{"bans":[],"total":0}"#.utf8))
            }
            return (200, Data(#"{"ok":true}"#.utf8))
        }

        let viewModel = makeViewModel()
        await viewModel.promoteBanToPlatform(banId: "ban-42")

        let promoteRequests = MockURLProtocol.capturedRequests.filter {
            $0.url?.path == "/api/bans/platform/promote"
        }
        XCTAssertEqual(promoteRequests.count, 1, "expected exactly one promote call")
        XCTAssertEqual(promoteRequests.first?.httpMethod, "POST")

        // Pin the wire body. The ban id is the only thing the server needs: it
        // resolves the source row itself and copies the already-hashed phone,
        // so no plaintext number ever leaves the device.
        let body = try XCTUnwrap(MockURLProtocol.capturedBodies.first)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(json.count, 1, "promote body carries only the ban id, got \(json)")
        XCTAssertEqual(
            json["banId"] as? String, "ban-42",
            "server validator is promoteBanBodySchema({banId}); got \(json)"
        )

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.successMessage, "a successful promote reports success")
    }

    func testPromoteBanToPlatformSurfacesServerRejection() async {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }

        // 409 = "Ban is already platform-scoped" (apps/worker/routes/platform-bans.ts).
        MockURLProtocol.requestHandler = { _ in
            (409, Data(#"{"error":"Ban is already platform-scoped"}"#.utf8))
        }

        let viewModel = makeViewModel()
        await viewModel.promoteBanToPlatform(banId: "ban-already-platform")

        XCTAssertNotNil(viewModel.errorMessage, "a rejected promote must not look successful")
        XCTAssertNil(viewModel.successMessage)
    }

    // MARK: - Helpers

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
